/**
 * Deployment tracks of one app in one tenant.
 *
 * Administrators commonly keep two Intune apps for the same package: one
 * Available in Company Portal (the primary track) and one Required with the
 * Update Only intent, which requirement rules gate to devices that already
 * have the app (the update-only track). Each track has its own assignments,
 * requirement rules and predecessor in Intune, so an update has to rebuild
 * each one from its own last deployment instead of from whichever of the two
 * was deployed last.
 */

import type { DatabaseAdapter, PackagingJob, UploadHistoryRecord } from '@/lib/db/types';

export type DeploymentTrack = 'primary' | 'update_only';

export interface TrackDeployment {
  track: DeploymentTrack;
  /** Newest deployment of this track in the tenant. */
  uploadHistory: UploadHistoryRecord;
  /** Its packaging job; null when the job no longer exists. */
  job: PackagingJob | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classify a package_config or deployment config. An explicit deploymentTrack
 * wins; otherwise any Update Only assignment makes it the update-only track.
 */
export function classifyDeploymentTrack(config: unknown): DeploymentTrack {
  if (!isRecord(config)) {
    return 'primary';
  }
  if (config.deploymentTrack === 'primary' || config.deploymentTrack === 'update_only') {
    return config.deploymentTrack;
  }
  const assignments = Array.isArray(config.assignments) ? config.assignments : [];
  if (assignments.some((assignment) => isRecord(assignment) && assignment.intent === 'updateOnly')) {
    return 'update_only';
  }
  const assignedGroups = Array.isArray(config.assignedGroups) ? config.assignedGroups : [];
  return assignedGroups.some((group) => isRecord(group) && group.assignmentType === 'updateOnly')
    ? 'update_only'
    : 'primary';
}

// Deployments read per app before giving up on finding the second track. A
// tenant redeploying one track many times would otherwise read every job.
const MAX_DEPLOYMENTS_SCANNED = 25;

/**
 * Newest deployment of each track of an app in a tenant, primary first. A
 * deployment whose packaging job is gone cannot be classified and counts as
 * primary, so it still surfaces as orphaned instead of being skipped.
 */
export async function findTrackDeployments(
  db: DatabaseAdapter,
  tenantId: string,
  wingetId: string
): Promise<TrackDeployment[]> {
  const history = (await db.uploadHistory.getByTenantId(tenantId))
    .filter((row) => row.winget_id === wingetId)
    .slice(0, MAX_DEPLOYMENTS_SCANNED);

  const found = new Map<DeploymentTrack, TrackDeployment>();
  for (const row of history) {
    const job = row.packaging_job_id ? await db.jobs.getById(row.packaging_job_id) : null;
    const track = job ? classifyDeploymentTrack(job.package_config) : 'primary';
    if (!found.has(track)) {
      found.set(track, { track, uploadHistory: row, job });
    }
    if (found.size === 2) {
      break;
    }
  }

  return (['primary', 'update_only'] as const)
    .map((track) => found.get(track))
    .filter((deployment): deployment is TrackDeployment => Boolean(deployment));
}

/**
 * The deployment whose configuration represents the app as a whole: the
 * primary track when there is one, otherwise the only track.
 */
export function selectRepresentativeDeployment(
  deployments: TrackDeployment[]
): TrackDeployment | null {
  return deployments.find((deployment) => deployment.track === 'primary') ?? deployments[0] ?? null;
}
