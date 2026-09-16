/**
 * Persist the result of an update scan for one user and tenant.
 *
 * Shared by the on-demand refresh route and the scheduled one, so the two
 * cannot drift on the part that is easy to get subtly wrong: which per-user
 * state survives a rewrite.
 */

import { getDatabase } from '@/lib/db';
import { isCriticalUpdate } from '@/lib/version-compare';
import type { AppUpdateInfo } from '@/types/inventory';

export interface StoredScanSummary {
  /** Rows written for this user and tenant. */
  refreshedCount: number;
  /** Rows that existed before and no longer apply. */
  removedCount: number;
  /** Rows that are new or changed and therefore await a notification. */
  pendingNotifications: number;
}

/**
 * Replace a user's cached updates for one tenant with the scan's result.
 *
 * The set is replaced rather than merged: an update that no longer appears in
 * the scan must disappear instead of lingering as a phantom.
 *
 * notified_at and dismissed_at are the only things the scan cannot know, so
 * they are carried over - but only while latest_version is unchanged. Without
 * that reset a row already notified for an older version keeps its
 * notified_at and the next version bump is never announced, and a dismissal
 * made for one version would go on hiding the next.
 */
export async function storeScanForUser({
  userId,
  tenantId,
  updates,
  now = new Date().toISOString(),
}: {
  userId: string;
  tenantId: string;
  updates: AppUpdateInfo[];
  now?: string;
}): Promise<StoredScanSummary> {
  const db = getDatabase();

  const priorRows = await db.updateCheckResults.getByUserId(userId, tenantId);
  const priorMap = new Map<
    string,
    { latest_version: string; notified_at: string | null; dismissed_at: string | null }
  >();
  priorRows.forEach((row) =>
    priorMap.set(`${row.winget_id}:${row.intune_app_id}`, {
      latest_version: row.latest_version,
      notified_at: row.notified_at,
      dismissed_at: row.dismissed_at,
    })
  );

  const rows = updates
    .filter((update) => Boolean(update.wingetId))
    .filter((update) => update.currentVersion !== 'Unknown')
    .map((update) => {
      const prior = priorMap.get(`${update.wingetId as string}:${update.intuneApp.id}`);
      const unchanged = Boolean(prior && prior.latest_version === update.latestVersion);
      return {
        user_id: userId,
        tenant_id: tenantId,
        winget_id: update.wingetId as string,
        intune_app_id: update.intuneApp.id,
        display_name: update.intuneApp.displayName,
        current_version: update.currentVersion,
        latest_version: update.latestVersion,
        is_critical: isCriticalUpdate(update.currentVersion, update.latestVersion),
        is_managed: update.isManaged,
        large_icon_type: update.intuneApp.largeIcon?.type || null,
        large_icon_value: update.intuneApp.largeIcon?.value || null,
        notified_at: unchanged ? prior!.notified_at : null,
        dismissed_at: unchanged ? prior!.dismissed_at : null,
        detected_at: now,
        updated_at: now,
      };
    });

  await db.updateCheckResults.replaceForUserAndTenant(userId, tenantId, rows);

  const activeKeys = new Set(rows.map((row) => `${row.winget_id}:${row.intune_app_id}`));
  return {
    refreshedCount: rows.length,
    removedCount: priorRows.filter(
      (row) => !activeKeys.has(`${row.winget_id}:${row.intune_app_id}`)
    ).length,
    pendingNotifications: rows.filter((row) => row.notified_at === null).length,
  };
}
