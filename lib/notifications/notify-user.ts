/**
 * Per-user update notification dispatch.
 *
 * Shared by the daily send-notifications cron and the on-demand
 * /api/updates/refresh route so update notifications go out the same way
 * whether they are batched nightly or triggered right after a user-facing
 * refresh detects a new update. Keeping this in one place avoids the two
 * paths drifting apart.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendUpdateNotificationEmail, isEmailConfigured } from '@/lib/email/service';
import { deliverWebhook } from '@/lib/webhooks/service';
import { getDatabase } from '@/lib/db';
import type {
  NotificationPreferences,
  WebhookConfiguration,
  UpdateCheckResult,
  NotificationPayload,
  AppUpdate,
} from '@/types/notifications';
import { shouldSkipUpdate, type AppUpdatePolicy } from '@/types/update-policies';

interface UserProfile {
  id: string;
  email: string | null;
  name: string | null;
  tenant_name: string | null;
}

export interface NotifyUserResult {
  emailsSent: number;
  webhooksSent: number;
  notifiedUpdateIds: string[];
  errors: string[];
}

/**
 * Determine if an email notification should be sent based on frequency.
 * daily/immediate: always send (the cron runs daily; immediate means "now").
 * weekly: only on Sundays.
 */
export function shouldSendBasedOnFrequency(frequency: string): boolean {
  if (frequency === 'weekly') {
    return new Date().getDay() === 0;
  }
  // daily and immediate both send on this run
  return true;
}

/**
 * Send email + webhook notifications for a single user's pending updates and
 * mark the delivered ones notified. Updates skipped by the user's ignore or
 * pin policy are neither sent nor marked notified.
 *
 * @param pendingUpdates Optional preloaded pending rows for the user. When
 *   omitted, the function loads update_check_results rows with notified_at and
 *   dismissed_at null itself. Pass `respectFrequency: false` to force-send
 *   regardless of the user's email frequency (used by on-demand refresh, where
 *   the user just asked for a check).
 */
export async function notifyUserOfPendingUpdates(
  /**
   * null in a self-hosted install. Webhooks work without it - only their
   * storage ever needed Supabase, and delivery is plain logic - so the
   * Supabase-only channels (email, the notification centre and its history)
   * are skipped rather than the whole run being refused.
   */
  supabase: SupabaseClient | null,
  userId: string,
  options: {
    pendingUpdates?: UpdateCheckResult[];
    respectFrequency?: boolean;
  } = {}
): Promise<NotifyUserResult> {
  const respectFrequency = options.respectFrequency ?? true;

  const result: NotifyUserResult = {
    emailsSent: 0,
    webhooksSent: 0,
    notifiedUpdateIds: [],
    errors: [],
  };

  const db = getDatabase();

  // Load pending updates for the user if not supplied. update_check_results
  // exists in both backends, so this goes through the db abstraction.
  let updates = options.pendingUpdates;
  if (!updates) {
    try {
      updates = (await db.updateCheckResults.getByUserId(userId)).filter(
        (row) => row.notified_at === null && row.dismissed_at === null
      );
    } catch (error) {
      result.errors.push(
        `Error fetching pending updates: ${error instanceof Error ? error.message : 'unknown'}`
      );
      return result;
    }
  }

  if (updates.length === 0) {
    return result;
  }

  // Respect the per-app update policies the same way the update check and
  // auto-update paths do: an ignored app, or a pinned app whose detected
  // version is not the pinned one, never produces a notification. The refresh
  // route stores rows for those apps too (the Updates page shows them), so
  // they have to be filtered here.
  //
  // Skipped rows are deliberately NOT marked notified. They stay pending and
  // are skipped again on every run while the policy applies. If the admin
  // removes the ignore policy or the detected version becomes the pinned one,
  // the next run notifies about it instead of the update being silently
  // swallowed. If the policies cannot be loaded, send nothing and leave every
  // row pending so the next run retries; a late notification is better than
  // one for an app the admin chose to ignore.
  const policies = await loadUpdatePolicies(supabase, userId);
  if ('error' in policies) {
    result.errors.push(`Error fetching update policies: ${policies.error}`);
    return result;
  }
  const policyByApp = new Map<string, NotificationPolicy>();
  policies.rows.forEach((policy) => {
    policyByApp.set(`${policy.tenant_id}:${policy.winget_id}`, policy);
  });
  updates = updates.filter(
    (u) => !shouldSkipUpdate(policyByApp.get(`${u.tenant_id}:${u.winget_id}`), u.latest_version)
  );

  if (updates.length === 0) {
    return result;
  }

  // notification_preferences and user_profiles have no SQLite equivalent, so
  // without Supabase there are no preferences to honour and no address to mail
  // to - the webhook channel carries the run on its own.
  const [prefsRow, profileRow] = supabase
    ? await Promise.all([
        supabase
          .from('notification_preferences')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle()
          .then((r) => r.data),
        supabase
          .from('user_profiles')
          .select('id, email, name, tenant_name')
          .eq('id', userId)
          .maybeSingle()
          .then((r) => r.data),
      ])
    : [null, null];

  const userWebhooks = (await db.webhooks.getEnabledByUserId(
    userId
  )) as unknown as WebhookConfiguration[];

  const prefs = (prefsRow as NotificationPreferences | null) || undefined;
  const profile = (profileRow as UserProfile | null) || undefined;

  // Filter updates based on preferences
  let filteredUpdates = updates;
  if (prefs?.notify_critical_only) {
    filteredUpdates = updates.filter((u) => u.is_critical);
  }

  if (filteredUpdates.length === 0) {
    // Nothing matches the user's filter; mark all as notified so they are not
    // reconsidered every run.
    result.notifiedUpdateIds.push(...updates.map((u) => u.id));
    await markNotified(userId, result.notifiedUpdateIds);
    return result;
  }

  // Group by tenant for payload
  const tenantUpdates = new Map<string, UpdateCheckResult[]>();
  filteredUpdates.forEach((u) => {
    if (!tenantUpdates.has(u.tenant_id)) {
      tenantUpdates.set(u.tenant_id, []);
    }
    tenantUpdates.get(u.tenant_id)!.push(u);
  });

  for (const [tenantId, tenantUpdateList] of tenantUpdates) {
    const appUpdates: AppUpdate[] = tenantUpdateList.map((u) => ({
      app_name: u.display_name,
      winget_id: u.winget_id,
      intune_app_id: u.intune_app_id,
      current_version: u.current_version,
      latest_version: u.latest_version,
      is_critical: u.is_critical,
    }));

    const criticalCount = appUpdates.filter((u) => u.is_critical).length;

    const payload: NotificationPayload = {
      event: 'app_updates_available',
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      tenant_name: profile?.tenant_name || undefined,
      updates: appUpdates,
      summary: { total: appUpdates.length, critical: criticalCount },
    };

    let delivered = false;

    // Send email if enabled and configured
    if (prefs?.email_enabled && isEmailConfigured()) {
      const shouldSendEmail = !respectFrequency || shouldSendBasedOnFrequency(prefs.email_frequency);
      if (shouldSendEmail) {
        const emailAddress = prefs.email_address || profile?.email;
        if (emailAddress) {
          const emailResult = await sendUpdateNotificationEmail(
            emailAddress,
            payload,
            profile?.name || undefined
          );

          // Only reachable with Supabase - prefs come from there, so the email
          // branch cannot run without it - but stated rather than implied.
          await supabase?.from('notification_history').insert({
            user_id: userId,
            channel: 'email',
            payload,
            status: emailResult.success ? 'sent' : 'failed',
            error_message: emailResult.error || null,
            apps_notified: appUpdates.length,
            sent_at: emailResult.success ? new Date().toISOString() : null,
          });

          if (emailResult.success) {
            delivered = true;
            result.emailsSent++;
          } else {
            result.errors.push(`Email to ${emailAddress} failed: ${emailResult.error}`);
          }
        } else {
          result.errors.push(
            `No email address available for user ${userId} (email_enabled is true but no address found)`
          );
        }
      }
    }

    // Send webhooks
    for (const webhook of userWebhooks) {
      const webhookResult = await deliverWebhook(webhook, payload);

      const statusUpdate: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (webhookResult.success) {
        statusUpdate.last_success_at = new Date().toISOString();
        statusUpdate.failure_count = 0;
      } else {
        statusUpdate.last_failure_at = new Date().toISOString();
        statusUpdate.failure_count = (webhook.failure_count || 0) + 1;
      }

      // Circuit-breaker state lives with the webhook, so it goes through the
      // db abstraction and survives without Supabase.
      await db.webhooks.update(webhook.id, userId, statusUpdate);

      // notification_history is Supabase-only; without it the delivery still
      // happened, it is just not recorded in the notification centre.
      if (supabase) {
        await supabase.from('notification_history').insert({
          user_id: userId,
          channel: 'webhook',
          webhook_id: webhook.id,
          payload,
          status: webhookResult.success ? 'sent' : 'failed',
          error_message: webhookResult.error || null,
          apps_notified: appUpdates.length,
          sent_at: webhookResult.success ? new Date().toISOString() : null,
        });
      }

      if (webhookResult.success) {
        delivered = true;
        result.webhooksSent++;
      } else {
        result.errors.push(`Webhook ${webhook.name} failed: ${webhookResult.error}`);
      }
    }

    // Only mark updates notified when at least one channel delivered, so
    // undelivered updates are retried on the next run until a valid channel
    // exists.
    if (delivered) {
      result.notifiedUpdateIds.push(...tenantUpdateList.map((u) => u.id));
    }
  }

  await markNotified(userId, result.notifiedUpdateIds);
  return result;
}

type NotificationPolicy = Pick<
  AppUpdatePolicy,
  'id' | 'tenant_id' | 'winget_id' | 'policy_type' | 'pinned_version'
>;

const POLICY_PAGE_SIZE = 1000;

/**
 * Load every update policy of the user. Paged so a user with more policies
 * than the Supabase row limit (an MSP across many tenants) still has all of
 * their ignore and pin policies applied. Keyset paged on the primary key and
 * ended only by an empty page, so a server max-rows setting below
 * POLICY_PAGE_SIZE cannot end the read early and drop policies.
 */
async function loadUpdatePolicies(
  supabase: SupabaseClient | null,
  userId: string
): Promise<{ rows: NotificationPolicy[] } | { error: string }> {
  if (!supabase) {
    // Self-hosted: policies live in the local database, which has no row cap
    // to page around.
    try {
      return { rows: await getDatabase().updatePolicies.list(userId) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'unknown error' };
    }
  }
  const rows: NotificationPolicy[] = [];
  let lastId: string | null = null;
  for (;;) {
    let query = supabase
      .from('app_update_policies')
      .select('id, tenant_id, winget_id, policy_type, pinned_version')
      .eq('user_id', userId);
    if (lastId !== null) {
      query = query.gt('id', lastId);
    }
    const { data, error } = await query.order('id', { ascending: true }).limit(POLICY_PAGE_SIZE);
    if (error) {
      return { error: error.message };
    }
    const page = (data as NotificationPolicy[] | null) || [];
    if (page.length === 0) {
      return { rows };
    }
    rows.push(...page);
    lastId = page[page.length - 1].id;
  }
}

async function markNotified(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // update_check_results exists in both backends; the adapter scopes the
  // stamp to the owning user and chunks where the backend needs it.
  await getDatabase().updateCheckResults.setNotifiedAt(
    ids,
    userId,
    new Date().toISOString()
  );
}
