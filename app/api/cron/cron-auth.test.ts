import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  createClientMock,
  processPendingBatchesMock,
  advanceInProgressBatchesMock,
  notifyUserOfPendingUpdatesMock,
  keepActuallyStaleJobsMock,
  handleAutoUpdateJobCompletionMock,
  getCatalogSourceMock,
  createWingetManifestClientMock,
  resolveWingetManifestMock,
  classifyWingetSyncRunMock,
  normalizeInstallerMock,
  normalizeManifestInstallersMock,
  selectAppsToSyncMock,
} = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  processPendingBatchesMock: vi.fn(),
  advanceInProgressBatchesMock: vi.fn(),
  notifyUserOfPendingUpdatesMock: vi.fn(),
  keepActuallyStaleJobsMock: vi.fn(),
  handleAutoUpdateJobCompletionMock: vi.fn(),
  getCatalogSourceMock: vi.fn(),
  createWingetManifestClientMock: vi.fn(),
  resolveWingetManifestMock: vi.fn(),
  classifyWingetSyncRunMock: vi.fn(),
  normalizeInstallerMock: vi.fn(),
  normalizeManifestInstallersMock: vi.fn(),
  selectAppsToSyncMock: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
vi.mock('@/lib/msp/batch-orchestrator', () => ({
  processPendingBatches: processPendingBatchesMock,
  advanceInProgressBatches: advanceInProgressBatchesMock,
}));
vi.mock('@/lib/notifications/notify-user', () => ({
  notifyUserOfPendingUpdates: notifyUserOfPendingUpdatesMock,
}));
vi.mock('@/lib/stale-jobs', () => ({
  STALE_JOB_TIMEOUT_MINUTES: 30,
  INTERMEDIATE_STATES: ['queued', 'packaging', 'uploading'],
  STALE_JOB_ERROR_MESSAGE: 'Timed out',
  keepActuallyStaleJobs: keepActuallyStaleJobsMock,
}));
vi.mock('@/lib/auto-update/cleanup', () => ({
  handleAutoUpdateJobCompletion: handleAutoUpdateJobCompletionMock,
}));
vi.mock('@/lib/version-compare', () => ({
  parseVersion: vi.fn(() => [1, 0, 0]),
  compareVersions: vi.fn(() => 0),
}));
vi.mock('@/lib/auto-update/trigger', () => ({
  AutoUpdateTrigger: vi.fn(),
  getLatestInstallerInfo: vi.fn(),
}));
vi.mock('@/types/update-policies', () => ({
  shouldSkipUpdate: vi.fn(() => false),
}));
vi.mock('@/lib/catalog', () => ({ getCatalogSource: getCatalogSourceMock }));
vi.mock('@/lib/winget-sync-resolution.mjs', () => ({
  classifyWingetSyncRun: classifyWingetSyncRunMock,
  createWingetManifestClient: createWingetManifestClientMock,
  resolveWingetManifest: resolveWingetManifestMock,
}));
vi.mock('@/lib/manifest-api', () => ({
  normalizeInstaller: normalizeInstallerMock,
  normalizeManifestInstallers: normalizeManifestInstallersMock,
}));
vi.mock('./sync-packages/select-apps', () => ({
  selectAppsToSync: selectAppsToSyncMock,
}));

function request(auth: string) {
  return new Request('http://localhost/api/cron/validation', {
    headers: { authorization: auth },
  });
}

function makeQuery(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'lt', 'is', 'order', 'upsert', 'update', 'insert', 'delete']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

function makeSupabaseClient() {
  const client = {
    from: vi.fn((table: string) => {
      if (table === 'packaging_jobs') return makeQuery({ data: [], error: null });
      if (table === 'update_check_results') return makeQuery({ data: [], error: null });
      if (table === 'notification_preferences') return makeQuery({ data: [], error: null });
      if (table === 'webhook_configurations') return makeQuery({ data: [], error: null });
      if (table === 'app_update_policies') return makeQuery({ data: [], error: null });
      if (table === 'curated_sync_status') return makeQuery({ error: null });
      return makeQuery({ data: [], error: null });
    }),
  };
  return client;
}

describe('cron route authentication', () => {
  const routes = [
    ['check-updates', './check-updates/route'],
    ['cleanup-stale-jobs', './cleanup-stale-jobs/route'],
    ['process-batches', './process-batches/route'],
    ['send-notifications', './send-notifications/route'],
    ['sync-packages', './sync-packages/route'],
  ] as const;

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each(routes)(
    'rejects Bearer undefined for %s while CRON_SECRET is unset',
    async (_name, modulePath) => {
      delete process.env.CRON_SECRET;
      // Supabase configured, so a 401 cannot be a missing-config error
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
      createClientMock.mockReturnValue(makeSupabaseClient());

      const route = await import(modulePath);
      const response = await route.GET(request('Bearer undefined'));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
      expect(createClientMock).not.toHaveBeenCalled();
    }
  );

  it.each(routes)('rejects a wrong secret for %s', async (_name, modulePath) => {
    process.env.CRON_SECRET = 'the-real-secret';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    createClientMock.mockReturnValue(makeSupabaseClient());

    const route = await import(modulePath);
    const response = await route.GET(request('Bearer totally-wrong-secret'));

    expect(response.status).toBe(401);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it.each(routes)('runs %s for the configured secret', async (_name, modulePath) => {
    process.env.CRON_SECRET = 'the-real-secret';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    createClientMock.mockReturnValue(makeSupabaseClient());
    processPendingBatchesMock.mockResolvedValue({ batchesProcessed: 1, itemsStarted: 2, errors: [] });
    advanceInProgressBatchesMock.mockResolvedValue({ staleItemsRecovered: 3, batchesCompleted: 4, errors: [] });
    keepActuallyStaleJobsMock.mockResolvedValue([]);
    createWingetManifestClientMock.mockReturnValue({});
    selectAppsToSyncMock.mockResolvedValue([]);

    const route = await import(modulePath);
    const response = await route.GET(request('Bearer the-real-secret'));

    expect(response.status).toBe(200);
  });
});
