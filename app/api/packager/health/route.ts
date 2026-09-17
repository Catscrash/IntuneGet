/**
 * Packager Health Check API
 * Returns the health status of the local packager system
 * Also handles stale job recovery in SQLite mode
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase, getDatabaseMode, verifyPackagerApiKey } from '@/lib/db';
import { getFeatureFlags } from '@/lib/features';

interface ActivePackagerInfo {
  id: string;
  /** What the packager reported at its last claim, or null if it predates this. */
  build: string | null;
  lastSeenAt: string;
}

interface PackagerStats {
  activePackagers: number;
  queuedJobs: number;
  processingJobs: number;
  recentCompletedJobs: number;
  recentFailedJobs: number;
  staleJobsRecovered?: number;
}

// Stale job timeout: 5 minutes (should match packager config)
const STALE_JOB_TIMEOUT_MS = 5 * 60 * 1000;

function verifyPackagerAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const providedKey = authHeader.slice(7);
  return verifyPackagerApiKey(providedKey);
}

export async function GET(request: NextRequest) {
  try {
    const features = getFeatureFlags();

    if (!features.localPackager) {
      return NextResponse.json({
        status: 'disabled',
        message: 'Local packager mode is not enabled. Set PACKAGER_MODE=local to enable.',
      });
    }

    if (!verifyPackagerAuth(request)) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid packager credentials' },
        { status: 401 }
      );
    }

    const db = getDatabase();
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - STALE_JOB_TIMEOUT_MS);

    // Recover stale jobs during health check
    // This acts as a periodic cleanup since there's no background worker
    let staleJobsRecovered = 0;
    const staleJobs = await db.jobs.getStaleJobs(staleThreshold);
    for (const job of staleJobs) {
      const released = await db.jobs.forceRelease(job.id, staleThreshold);
      if (released) {
        staleJobsRecovered++;
      }
    }

    // Get job statistics
    const jobStats = await db.jobs.getStats();

    // A packager only ever makes itself known by working, so the jobs are the
    // register. Anything that has claimed within the stale window is live.
    const packagers: ActivePackagerInfo[] = (
      await db.jobs.listActivePackagers(staleThreshold)
    ).map((row) => ({
      id: row.packager_id,
      build: row.packager_build,
      lastSeenAt: row.last_seen_at,
    }));

    const stats: PackagerStats = {
      activePackagers: packagers.length,
      queuedJobs: jobStats.queued,
      processingJobs: jobStats.packaging + jobStats.uploading,
      recentCompletedJobs: jobStats.deployed,
      recentFailedJobs: jobStats.failed,
    };

    if (staleJobsRecovered > 0) {
      stats.staleJobsRecovered = staleJobsRecovered;
    }

    // Determine overall health status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const issues: string[] = [];

    if (stats.queuedJobs > 0 && packagers.length === 0) {
      status = 'unhealthy';
      issues.push('No active packagers but jobs are queued');
    } else if (stats.queuedJobs > 10) {
      status = 'degraded';
      issues.push('Large job queue - consider adding more packagers');
    }

    if (stats.recentFailedJobs > stats.recentCompletedJobs && stats.recentFailedJobs > 0) {
      status = status === 'healthy' ? 'degraded' : status;
      issues.push('More failures than successes');
    }

    return NextResponse.json({
      status,
      mode: 'local',
      databaseMode: getDatabaseMode(),
      timestamp: now.toISOString(),
      stats,
      // Which build is actually out there. The packager runs on its own
      // machine and release cadence, so this cannot be read off the server
      // otherwise - and it is the first thing worth knowing when a package
      // comes out wrong.
      packagers,
      issues: issues.length > 0 ? issues : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        message: 'Failed to check packager health',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
