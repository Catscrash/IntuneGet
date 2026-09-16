/**
 * Minimal scheduler for self-hosted deployments.
 *
 * The cron routes are ordinary HTTP endpoints that the hosting platform calls
 * on a schedule. A container deployment has no such platform, so nothing ever
 * called them and the jobs behind them simply never ran. This calls them on an
 * interval instead.
 *
 * Deliberately interval-based rather than wall-clock: none of these jobs care
 * what time of day they run, and an interval needs no timezone handling, no
 * catch-up logic after a restart, and no cron parser.
 *
 * Runs from the application image, so it needs no second image to pull and no
 * package of its own.
 */

import { pathToFileURL } from 'node:url';

const target = (process.env.SCHEDULER_TARGET || 'http://web:3000').replace(/\/+$/, '');
const secret = process.env.CRON_SECRET || '';

/**
 * Jobs as "path:seconds", comma-separated. The default is the one job that
 * works without Supabase; a Supabase-backed deployment can add the others
 * (check-updates, cleanup-stale-jobs, send-notifications, ...) here.
 */
const DEFAULT_JOBS = '/api/cron/refresh-updates:21600';

export function parseJobs(spec) {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf(':');
      const path = entry.slice(0, at).trim();
      const seconds = Number(entry.slice(at + 1));
      if (!path.startsWith('/') || !Number.isFinite(seconds) || seconds < 30) {
        throw new Error(`Invalid job "${entry}" (expected "/path:seconds", seconds >= 30)`);
      }
      return { path, seconds };
    });
}

function log(message) {
  console.log(`[scheduler] ${new Date().toISOString()} ${message}`);
}

async function runJob(job) {
  const url = `${target}${job.path}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await response.text();
    if (!response.ok) {
      // Logged rather than thrown: a failing job must not take the loop with
      // it, or one broken endpoint would silently stop every other schedule.
      log(`${job.path} -> HTTP ${response.status} ${body.slice(0, 300)}`);
      return;
    }
    log(`${job.path} -> ok ${body.slice(0, 300)}`);
  } catch (error) {
    log(`${job.path} -> failed: ${error instanceof Error ? error.message : error}`);
  }
}

async function loop(job) {
  // Stagger the first run so a restart does not fire everything at once, and
  // so the web service has a moment to come up.
  await new Promise((r) => setTimeout(r, 15_000));
  for (;;) {
    await runJob(job);
    await new Promise((r) => setTimeout(r, job.seconds * 1000));
  }
}

function main() {
  if (!secret) {
    // The routes reject every unauthenticated call, so without the secret this
    // would loop forever producing 401s. Fail loudly at startup instead.
    console.error('[scheduler] CRON_SECRET is not set; the cron routes would reject every call.');
    process.exit(1);
  }

  const jobs = parseJobs(process.env.SCHEDULER_JOBS || DEFAULT_JOBS);
  log(`target ${target}, jobs: ${jobs.map((j) => `${j.path} every ${j.seconds}s`).join(', ')}`);
  jobs.forEach((job) => void loop(job));
}

// Only when run as the container's command, so the parser above can be tested
// without starting the loops.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
