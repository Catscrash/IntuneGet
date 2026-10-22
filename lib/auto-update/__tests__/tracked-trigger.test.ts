/**
 * An app kept as a Company Portal app plus an Update Only app is updated as
 * two tracks: each new app is built from its own last deployment and replaces
 * its own predecessor, primary first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppUpdatePolicy, DeploymentConfig } from '@/types/update-policies';
import type { UpdateInfo } from '../trigger';

const { getByTenantIdMock, getJobByIdMock } = vi.hoisted(() => ({
  getByTenantIdMock: vi.fn(),
  getJobByIdMock: vi.fn(),
}));

vi.mock('@/lib/db/supabase-adapter', () => ({
  supabaseDb: {
    uploadHistory: { getByTenantId: getByTenantIdMock },
    jobs: { getById: getJobByIdMock },
  },
}));

import { AutoUpdateTrigger } from '../trigger';

const AVAILABLE = [{ type: 'allUsers', intent: 'available' }];
const UPDATE_ONLY = [{ type: 'allDevices', intent: 'updateOnly' }];
const RULES = [{ '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRequirement', displayName: 'Installed' }];

function job(id: string, displayName: string, packageConfig: Record<string, unknown>) {
  return {
    id,
    display_name: displayName,
    publisher: 'Mozilla',
    architecture: 'x64',
    installer_type: 'exe',
    install_command: 'setup.exe /S',
    uninstall_command: 'uninstall.exe /S',
    install_scope: 'machine',
    detection_rules: [],
    package_config: packageConfig,
  };
}

const JOBS: Record<string, ReturnType<typeof job>> = {
  'job-portal': job('job-portal', 'Firefox', { assignments: AVAILABLE }),
  'job-update': job('job-update', 'Firefox (Update)', { assignments: UPDATE_ONLY, requirementRules: RULES }),
};

function history(id: string, jobId: string, intuneAppId: string, version: string) {
  return {
    id,
    packaging_job_id: jobId,
    user_id: 'user-1',
    winget_id: 'Mozilla.Firefox',
    version,
    display_name: 'Firefox',
    publisher: 'Mozilla',
    intune_app_id: intuneAppId,
    intune_app_url: null,
    intune_tenant_id: 'tenant-1',
    app_source: null,
    deployed_at: '2026-10-01T00:00:00.000Z',
  };
}

function policy(config: Partial<DeploymentConfig>): AppUpdatePolicy {
  return {
    id: 'policy-1',
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    winget_id: 'Mozilla.Firefox',
    policy_type: 'auto_update',
    pinned_version: null,
    deployment_config: { displayName: 'Firefox', ...config } as DeploymentConfig,
    original_upload_history_id: 'history-portal',
    last_auto_update_at: null,
    last_auto_update_version: null,
    is_enabled: true,
    consecutive_failures: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

const UPDATE_INFO = {
  wingetId: 'Mozilla.Firefox',
  currentVersion: '130.0',
  latestVersion: '131.0',
  displayName: 'Firefox',
  installerUrl: 'https://example.test/firefox.exe',
  installerSha256: 'a'.repeat(64),
  installerType: 'exe',
  // The newest Intune app of the package, as the cron resolves it.
  currentIntuneAppId: 'intune-update',
} as UpdateInfo;

function createTrigger() {
  const trigger = new AutoUpdateTrigger('https://stub.supabase.co', 'stub-key');
  const policyUpdates: unknown[] = [];
  (trigger as unknown as { supabase: unknown }).supabase = {
    from: () => ({
      update: (payload: unknown) => {
        policyUpdates.push(payload);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  let jobNumber = 0;
  const triggerAutoUpdate = vi
    .spyOn(trigger, 'triggerAutoUpdate')
    .mockImplementation(async () => ({ success: true, packagingJobId: `new-job-${++jobNumber}` }));
  return { trigger, triggerAutoUpdate, policyUpdates };
}

describe('triggerTrackedAutoUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJobByIdMock.mockImplementation(async (id: string) => JOBS[id] ?? null);
    // Newest first: the Update Only app was deployed after the portal app.
    getByTenantIdMock.mockResolvedValue([
      history('history-update', 'job-update', 'intune-update', '130.0'),
      history('history-portal', 'job-portal', 'intune-portal', '130.0'),
    ]);
  });

  it('updates the Company Portal app first, then the Update Only app, each from its own predecessor', async () => {
    const { trigger, triggerAutoUpdate } = createTrigger();

    const result = await trigger.triggerTrackedAutoUpdate(policy({ assignments: AVAILABLE as never }), UPDATE_INFO);

    expect(result.success).toBe(true);
    expect(result.jobs.map((entry) => [entry.track, entry.packagingJobId, entry.sourceIntuneAppId])).toEqual([
      ['primary', 'new-job-1', 'intune-portal'],
      ['update_only', 'new-job-2', 'intune-update'],
    ]);

    const [primaryCall, secondaryCall] = triggerAutoUpdate.mock.calls;
    expect(primaryCall[0].deployment_config?.assignments).toEqual(AVAILABLE);
    expect(primaryCall[2]).toBeUndefined();

    expect(secondaryCall[0].id).toBe('policy-1');
    expect(secondaryCall[0].deployment_config).toMatchObject({
      displayName: 'Firefox (Update)',
      assignments: UPDATE_ONLY,
      requirementRules: RULES,
    });
    expect(secondaryCall[2]).toMatchObject({ skipRateLimits: true, secondaryTrack: true });
  });

  it('restores the primary config of a policy that was saved from the Update Only deployment', async () => {
    const { trigger, triggerAutoUpdate, policyUpdates } = createTrigger();
    const stale = policy({ assignments: UPDATE_ONLY as never, requirementRules: RULES as never });

    await trigger.triggerTrackedAutoUpdate(stale, UPDATE_INFO);

    expect(triggerAutoUpdate.mock.calls[0][0].deployment_config).toMatchObject({
      displayName: 'Firefox',
      assignments: AVAILABLE,
    });
    expect(triggerAutoUpdate.mock.calls[0][0].deployment_config?.requirementRules).toBeUndefined();
    expect(policyUpdates).toHaveLength(1);
  });

  it('holds the Update Only app when the Company Portal app was not queued', async () => {
    const { trigger, triggerAutoUpdate } = createTrigger();
    triggerAutoUpdate.mockResolvedValueOnce({ success: false, skipped: true, skipReason: 'Held by scope' });

    const result = await trigger.triggerTrackedAutoUpdate(policy({ assignments: AVAILABLE as never }), UPDATE_INFO);

    expect(triggerAutoUpdate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, skipped: true, jobs: [] });
  });

  it('reports an Update Only app that could not follow without failing the primary update', async () => {
    const { trigger, triggerAutoUpdate } = createTrigger();
    triggerAutoUpdate
      .mockResolvedValueOnce({ success: true, packagingJobId: 'new-job-1' })
      .mockResolvedValueOnce({ success: false, error: 'QA failed' });

    const result = await trigger.triggerTrackedAutoUpdate(policy({ assignments: AVAILABLE as never }), UPDATE_INFO);

    expect(result).toMatchObject({ success: true, packagingJobId: 'new-job-1', secondaryTrackError: 'QA failed' });
    expect(result.jobs).toHaveLength(1);
  });

  it('only updates the track that is still behind', async () => {
    const { trigger, triggerAutoUpdate } = createTrigger();
    getByTenantIdMock.mockResolvedValue([
      history('history-portal', 'job-portal', 'intune-portal', '131.0'),
      history('history-update', 'job-update', 'intune-update', '130.0'),
    ]);

    const result = await trigger.triggerTrackedAutoUpdate(policy({ assignments: AVAILABLE as never }), UPDATE_INFO);

    expect(triggerAutoUpdate).toHaveBeenCalledTimes(1);
    expect(result.jobs.map((entry) => entry.track)).toEqual(['update_only']);
  });

  it('keeps the single-app behaviour when the app has one track', async () => {
    const { trigger, triggerAutoUpdate } = createTrigger();
    getByTenantIdMock.mockResolvedValue([history('history-portal', 'job-portal', 'intune-portal', '130.0')]);
    const single = policy({ assignments: AVAILABLE as never });

    const result = await trigger.triggerTrackedAutoUpdate(single, UPDATE_INFO);

    expect(triggerAutoUpdate).toHaveBeenCalledWith(single, UPDATE_INFO, undefined);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceIntuneAppId).toBe('intune-update');
  });
});
