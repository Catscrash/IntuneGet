/**
 * Scheduled update scan.
 *
 * The existing check-updates route builds its own Supabase client and is
 * unusable in a SQLite self-host, which leaves the cached update rows with no
 * writer but the Refresh button. Two admins then sit on two private snapshots
 * of the tenant, each frozen at whenever they last clicked, and an app that had
 * no update at the time never gets a row at all.
 *
 * This runs the same scan the button runs, for every user/tenant pair the
 * local database knows about, through the db abstraction so it works in both
 * backends. Graph is reached with the tenant's service principal, so no signed-
 * in user is needed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getServerClientOrNull } from '@/lib/supabase';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { scanTenantForUpdates } from '@/app/api/intune/apps/updates/route';
import { storeScanForUser } from '@/lib/updates/store-scan';
import { notifyUserOfPendingUpdates } from '@/lib/notifications/notify-user';
import type { UserTenantPair } from '@/lib/db/types';

interface PairResult {
  userId: string;
  tenantId: string;
  refreshed?: number;
  removed?: number;
  error?: string;
}

/**
 * Who to scan for: anyone who has deployed into a tenant, plus anyone who
 * already has update rows there. The second half matters as much as the first
 * - an admin who only ever updates apps a colleague deployed has no deployment
 * history of their own, and would otherwise never be refreshed.
 */
async function collectUserTenants(): Promise<UserTenantPair[]> {
  const db = getDatabase();
  const [deployed, cached] = await Promise.all([
    db.uploadHistory.listUserTenants(),
    db.updateCheckResults.listUserTenants(),
  ]);

  const seen = new Map<string, UserTenantPair>();
  for (const pair of [...deployed, ...cached]) {
    if (!pair.user_id || !pair.tenant_id) continue;
    seen.set(`${pair.user_id}:${pair.tenant_id}`, pair);
  }
  return [...seen.values()];
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getServerClientOrNull();
  let pairs: UserTenantPair[];
  try {
    pairs = await collectUserTenants();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return NextResponse.json(
      { error: `Failed to list users to refresh: ${message}` },
      { status: 500 }
    );
  }

  const results: PairResult[] = [];

  // Sequential on purpose: each pair is a full Graph listing of the tenant's
  // Win32 apps, and several at once would race the same throttling limits
  // without finishing any sooner.
  for (const pair of pairs) {
    try {
      const scan = await scanTenantForUpdates({
        userId: pair.user_id,
        tenantId: pair.tenant_id,
        supabase,
      });
      const stored = await storeScanForUser({
        userId: pair.user_id,
        tenantId: pair.tenant_id,
        updates: scan.updates,
      });

      // Respect the user's configured frequency here, unlike the on-demand
      // refresh: nobody asked for this run, so it must not turn into a second
      // notification channel of its own. Failures stay local to the pair.
      if (stored.pendingNotifications > 0) {
        try {
          await notifyUserOfPendingUpdates(supabase, pair.user_id);
        } catch (notifyError) {
          console.error(
            'Scheduled update notification failed:',
            notifyError instanceof Error ? notifyError.message : notifyError
          );
        }
      }

      results.push({
        userId: pair.user_id,
        tenantId: pair.tenant_id,
        refreshed: stored.refreshedCount,
        removed: stored.removedCount,
      });
    } catch (error) {
      // One tenant without consent, or a service principal that cannot get a
      // token, must not stop the rest. The failure is reported per pair.
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `Scheduled refresh failed for ${pair.user_id}@${pair.tenant_id}: ${message}`
      );
      results.push({ userId: pair.user_id, tenantId: pair.tenant_id, error: message });
    }
  }

  const failed = results.filter((r) => r.error).length;
  return NextResponse.json({
    success: failed === 0,
    scanned: results.length,
    failed,
    refreshedRows: results.reduce((sum, r) => sum + (r.refreshed || 0), 0),
    results,
  });
}
