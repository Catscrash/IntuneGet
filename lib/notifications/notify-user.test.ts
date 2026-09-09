import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  sendEmailMock,
  isEmailConfiguredMock,
  deliverWebhookMock,
  getEnabledWebhooksMock,
  updateWebhookMock,
  setNotifiedAtMock,
} = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  isEmailConfiguredMock: vi.fn(),
  deliverWebhookMock: vi.fn(),
  getEnabledWebhooksMock: vi.fn(),
  updateWebhookMock: vi.fn(),
  setNotifiedAtMock: vi.fn(),
}));

vi.mock('@/lib/email/service', () => ({
  sendUpdateNotificationEmail: sendEmailMock,
  isEmailConfigured: isEmailConfiguredMock,
}));
vi.mock('@/lib/webhooks/service', () => ({
  deliverWebhook: deliverWebhookMock,
}));
// Webhook storage and the notified stamp exist in both backends, so they go
// through the db abstraction rather than the Supabase client.
vi.mock('@/lib/db', () => ({
  getDatabase: () => ({
    webhooks: {
      getEnabledByUserId: getEnabledWebhooksMock,
      update: updateWebhookMock,
    },
    updateCheckResults: {
      getByUserId: vi.fn(async () => []),
      setNotifiedAt: setNotifiedAtMock,
    },
  }),
}));

import { notifyUserOfPendingUpdates } from '@/lib/notifications/notify-user';

// Minimal chainable Supabase stub. Per-table results; webhook_configurations is
// awaited as a thenable list, prefs/profile via maybeSingle.
function makeSupabase(tables: Record<string, unknown>, calls: { markNotified: string[][]; histInserts: string[] }) {
  function builder(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      is: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve({ data: tables[table] ?? null, error: null }),
      insert: (row: any) => { if (table === 'notification_history') calls.histInserts.push(row.status); return Promise.resolve({ data: null, error: null }); },
      update: () => ({
        eq: () => Promise.resolve({ data: null, error: null }),
        in: (_c: string, ids: string[]) => { if (table === 'update_check_results') calls.markNotified.push(ids); return Promise.resolve({ data: null, error: null }); },
      }),
      then: (res: any) => res({ data: tables[table] ?? [], error: null }),
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as any;
}

describe('notifyUserOfPendingUpdates', () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    isEmailConfiguredMock.mockReset();
    deliverWebhookMock.mockReset();
    getEnabledWebhooksMock.mockReset();
    updateWebhookMock.mockReset();
    setNotifiedAtMock.mockReset();
    getEnabledWebhooksMock.mockResolvedValue([]);
    updateWebhookMock.mockResolvedValue(null);
    setNotifiedAtMock.mockResolvedValue(0);
  });

  const webhook = { id: 'w1', user_id: 'u1', name: 'WH', is_enabled: true, failure_count: 0 };
  const pendingUpdate = [{ id: 'upd1', user_id: 'u1', tenant_id: 't1', winget_id: 'Google.Chrome', intune_app_id: 'a1', display_name: 'Chrome', current_version: '1.0', latest_version: '2.0', is_critical: false }] as any;

  it('sends email + webhook and marks the update notified', async () => {
    isEmailConfiguredMock.mockReturnValue(true);
    sendEmailMock.mockResolvedValue({ success: true });
    deliverWebhookMock.mockResolvedValue({ success: true });

    const calls = { markNotified: [] as string[][], histInserts: [] as string[] };
    const supabase = makeSupabase({
      notification_preferences: { user_id: 'u1', email_enabled: true, email_frequency: 'daily', notify_critical_only: false, email_address: 'u1@test.com' },
      user_profiles: { id: 'u1', email: 'u1@test.com', name: 'User One', tenant_name: 'Tenant' },
    }, calls);

    getEnabledWebhooksMock.mockResolvedValue([webhook]);

    const res = await notifyUserOfPendingUpdates(supabase, 'u1', { pendingUpdates: pendingUpdate });

    expect(res.emailsSent).toBe(1);
    expect(res.webhooksSent).toBe(1);
    expect(res.notifiedUpdateIds).toEqual(['upd1']);
    expect(setNotifiedAtMock).toHaveBeenCalledWith(['upd1'], 'u1', expect.any(String));
    expect(calls.histInserts).toEqual(['sent', 'sent']);
  });

  it('delivers webhooks without Supabase and marks the update notified', async () => {
    // The point of the change: only webhook *storage* ever needed Supabase.
    // Delivery is plain logic, so a self-hosted install gets its Teams or
    // Slack message; email and the notification centre are skipped.
    deliverWebhookMock.mockResolvedValue({ success: true });
    getEnabledWebhooksMock.mockResolvedValue([webhook]);

    const res = await notifyUserOfPendingUpdates(null, 'u1', {
      pendingUpdates: pendingUpdate,
    });

    expect(res.webhooksSent).toBe(1);
    expect(res.emailsSent).toBe(0);
    expect(res.notifiedUpdateIds).toEqual(['upd1']);
    expect(setNotifiedAtMock).toHaveBeenCalledWith(['upd1'], 'u1', expect.any(String));
    // The circuit-breaker state still gets written - it lives with the webhook.
    expect(updateWebhookMock).toHaveBeenCalledWith(
      'w1',
      'u1',
      expect.objectContaining({ failure_count: 0 })
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('records a webhook failure without Supabase instead of losing it', async () => {
    deliverWebhookMock.mockResolvedValue({ success: false, error: 'HTTP 403' });
    getEnabledWebhooksMock.mockResolvedValue([webhook]);

    const res = await notifyUserOfPendingUpdates(null, 'u1', {
      pendingUpdates: pendingUpdate,
    });

    expect(res.webhooksSent).toBe(0);
    // Not marked notified, so the next run retries rather than dropping it.
    expect(res.notifiedUpdateIds).toEqual([]);
    expect(setNotifiedAtMock).not.toHaveBeenCalled();
    expect(updateWebhookMock).toHaveBeenCalledWith(
      'w1',
      'u1',
      expect.objectContaining({ failure_count: 1 })
    );
  });

  it('does NOT mark notified when all channels fail (retried next run)', async () => {
    isEmailConfiguredMock.mockReturnValue(true);
    sendEmailMock.mockResolvedValue({ success: false, error: 'smtp down' });
    deliverWebhookMock.mockResolvedValue({ success: false, error: 'HTTP 403' });

    const calls = { markNotified: [] as string[][], histInserts: [] as string[] };
    const supabase = makeSupabase({
      notification_preferences: { user_id: 'u1', email_enabled: true, email_frequency: 'daily', notify_critical_only: false, email_address: 'u1@test.com' },
      user_profiles: { id: 'u1', email: 'u1@test.com', name: 'User One', tenant_name: 'Tenant' },
    }, calls);

    getEnabledWebhooksMock.mockResolvedValue([webhook]);

    const res = await notifyUserOfPendingUpdates(supabase, 'u1', { pendingUpdates: pendingUpdate });

    expect(res.notifiedUpdateIds).toEqual([]);
    expect(setNotifiedAtMock).not.toHaveBeenCalled();
  });
});
