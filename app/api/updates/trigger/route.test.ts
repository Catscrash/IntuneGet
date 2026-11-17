import type { Mock } from 'vitest';
import { WorkflowDispatchUnconfirmedError, WorkflowDispatchRateLimitError } from '@/lib/workflow-dispatch-rate-limit';
import { QaGateNotPassedError } from '@/lib/qa/gate';
import { NextRequest } from 'next/server';
import type { AppUpdatePolicy, DeploymentConfig } from '@/types/update-policies';
import { canAutoUpdate } from '@/types/update-policies';

const {
  parseAccessTokenMock,
  createServerClientMock,
  getLatestInstallerInfoMock,
  triggerAutoUpdateMock,
  isGitHubActionsConfiguredMock,
  triggerPackagingWorkflowMock,
  getAppConfigMock,
  getFeatureFlagsMock,
  isSupabaseConfiguredMock,
  getDatabaseMock,
  getDetectedUpdatesMock,
  getPoliciesMock,
  getHistoryMock,
  createJobMock,
  buildDeploymentConfigForAppMock,
  appExistsMock,
  getUserSettingsMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  createServerClientMock: vi.fn(),
  getLatestInstallerInfoMock: vi.fn(),
  triggerAutoUpdateMock: vi.fn(),
  isGitHubActionsConfiguredMock: vi.fn(),
  triggerPackagingWorkflowMock: vi.fn(),
  getAppConfigMock: vi.fn(),
  getFeatureFlagsMock: vi.fn(),
  isSupabaseConfiguredMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getDetectedUpdatesMock: vi.fn(),
  getPoliciesMock: vi.fn(),
  getHistoryMock: vi.fn(),
  createJobMock: vi.fn(),
  buildDeploymentConfigForAppMock: vi.fn(),
  appExistsMock: vi.fn(),
  getUserSettingsMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/supabase', () => ({
  createServerClient: createServerClientMock,
  isSupabaseConfigured: isSupabaseConfiguredMock,
  isSupabaseServerConfigured: isSupabaseConfiguredMock,
}));

vi.mock('@/lib/db', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('@/lib/update-policies/build-deployment-config', () => ({
  buildDeploymentConfigForApp: buildDeploymentConfigForAppMock,
}));

vi.mock('@/lib/catalog', () => ({
  getCatalogSource: () => ({ appExists: appExistsMock }),
}));

vi.mock('@/lib/auto-update/trigger', () => ({
  AutoUpdateTrigger: class {
    triggerAutoUpdate = triggerAutoUpdateMock;
    // A single deployment track: the real method then forwards to
    // triggerAutoUpdate and reports its job.
    triggerTrackedAutoUpdate = async (
      policy: AppUpdatePolicy,
      updateInfo: { currentIntuneAppId?: string },
      options: unknown
    ) => {
      const result = await triggerAutoUpdateMock(policy, updateInfo, options);
      return {
        ...result,
        jobs: result?.success && result.packagingJobId
          ? [{
              track: 'primary',
              packagingJobId: result.packagingJobId,
              historyId: result.historyId,
              packageProfileSha256: result.packageProfileSha256,
              deploymentConfig: policy.deployment_config,
              sourceIntuneAppId: updateInfo.currentIntuneAppId,
            }]
          : [],
      };
    };
  },
  getLatestInstallerInfo: getLatestInstallerInfoMock,
  // The Supabase-less path reuses these so both paths write the same
  // package_config shape.
  normalizeAssignments: (config: DeploymentConfig) => config.assignments ?? [],
  normalizeCategories: (config: DeploymentConfig) => config.categories ?? [],
}));

vi.mock('@/lib/github-actions', () => ({
  isGitHubActionsConfigured: isGitHubActionsConfiguredMock,
  triggerPackagingWorkflow: triggerPackagingWorkflowMock,
}));

vi.mock('@/lib/config', () => ({
  getAppConfig: getAppConfigMock,
}));

vi.mock('@/lib/features', () => ({
  getFeatureFlags: getFeatureFlagsMock,
}));

// Tenant authorization has its own tests in lib/msp/tenant-resolution.test.ts.
// Here it allows the requested tenant unless a test says otherwise.
const { resolveTargetTenantIdMock } = vi.hoisted(() => ({ resolveTargetTenantIdMock: vi.fn() }));
vi.mock('@/lib/msp/tenant-resolution', () => ({
  resolveTargetTenantId: resolveTargetTenantIdMock,
}));
const allowRequestedTenant = async ({ requestedTenantId }: { requestedTenantId: string }) => ({
  tenantId: requestedTenantId,
  errorResponse: null,
});

import { NextResponse } from 'next/server';
import { POST } from '@/app/api/updates/trigger/route';

interface TriggerSupabaseMocks {
  // The route only ever reaches for from(<table>) and chains off the builder
  // it gets back, so the mocked builders are described by their shape
  supabase: { from: (table: string) => Record<string, unknown> };
  policyUpdatePayloads: Array<Record<string, unknown>>;
}

type ChainFn = Mock<(...args: unknown[]) => unknown>;

function createTriggerSupabaseMocks(
  policy: AppUpdatePolicy,
  options?: {
    latestUploadIntuneAppId?: string;
    userSettings?: Record<string, unknown>;
    storedJob?: Record<string, unknown>;
    readError?: boolean;
  }
): TriggerSupabaseMocks {
  const policyUpdatePayloads: Array<Record<string, unknown>> = [];

  const createSingleResultChain = <T,>(data: T) => {
    const chain: {
      eq: ChainFn;
      single: ChainFn;
    } = {
      eq: vi.fn(),
      single: vi.fn(),
    };
    chain.eq.mockImplementation((key: string, value: unknown) => {
      if (key === 'tenant_id' && data && typeof data === 'object' && 'tenant_id' in data) Object.assign(data, { tenant_id: value });
      return chain;
    });
    chain.single.mockResolvedValue({ data, error: null });
    return chain;
  };

  const supabase = {
    from: (table: string) => {
      // resolveTargetTenantId() looks the caller's MSP membership up first.
      // No row means a plain single-tenant user, which is what these tests
      // describe; the MSP cases live in lib/msp/tenant-resolution.test.ts.
      if (table === 'msp_user_memberships') {
        return { select: vi.fn(() => createSingleResultChain(null)) };
      }

      if (table === 'update_check_results') {
        return {
          select: vi.fn(() =>
            createSingleResultChain({
              id: 'update-1',
              current_version: '1.0.0',
            })
          ),
        };
      }

      if (table === 'app_update_policies') {
        return {
          select: vi.fn(() => createSingleResultChain({ ...policy })),
          update: vi.fn((payload: Record<string, unknown>) => {
            policyUpdatePayloads.push(payload);
            const query = { eq: vi.fn(() => query), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) };
            return query;
          }),
        };
      }

      if (table === 'upload_history') {
        const uploadChain: Record<string, ChainFn> = {
          select: vi.fn(),
          eq: vi.fn(),
          order: vi.fn(),
          limit: vi.fn(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: options?.latestUploadIntuneAppId
              ? { intune_app_id: options.latestUploadIntuneAppId }
              : null,
            error: null,
          }),
        };
        for (const key of Object.keys(uploadChain)) {
          if (key !== 'maybeSingle') {
            uploadChain[key].mockReturnValue(uploadChain);
          }
        }
        return { select: uploadChain.select };
      }

      if (table === 'packaging_jobs') {
        return { select: () => {
          const filters: Array<(row: Record<string, unknown>) => boolean> = [];
          const query = {
            eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
            is: (key: string, value: unknown) => { filters.push(row => (row[key] ?? null) === value); return query; },
            in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
            maybeSingle: async () => {
              const info = (await getLatestInstallerInfoMock.mock.results.at(-1)?.value)?.info ?? {};
              const config = policy.deployment_config ?? {};
              const id = (await triggerAutoUpdateMock.mock.results.at(-1)?.value)?.packagingJobId;
              const row = { id, user_id: policy.user_id, tenant_id: triggerAutoUpdateMock.mock.calls.at(-1)?.[0]?.tenant_id ?? policy.tenant_id,
                auto_update_policy_id: policy.id, is_auto_update: true, status: 'queued',
                winget_id: policy.winget_id, version: info.latestVersion,
                display_name: config.displayName || info.displayName, publisher: config.publisher,
                architecture: config.architecture, installer_type: info.installerType || config.installerType,
                installer_url: info.installerUrl, installer_sha256: info.installerSha256,
                install_command: info.installCommand || config.installCommand, uninstall_command: config.uninstallCommand,
                install_scope: info.installScope || config.installScope, detection_rules: config.detectionRules,
                package_config: { ...config, sourceType: info.sourceType || config.sourceType,
                  installerSuccessCodes: info.installerSuccessCodes, nestedInstallerType: info.nestedInstallerType,
                  nestedInstallerPath: info.nestedInstallerPath, forceCreate: config.forceCreateNewApp !== false,
                  sourceIntuneAppId: options?.latestUploadIntuneAppId,
                  autoSupersede: Boolean(options?.userSettings?.supersedePreviousApp && options?.latestUploadIntuneAppId),
                  supersedenceType: options?.userSettings?.supersedePreviousApp && options?.latestUploadIntuneAppId ? 'update' : undefined,
                  assignmentMigration: { carryOverAssignments: options?.userSettings?.carryOverAssignments ?? false },
                  // The production snapshot keeps the refreshed command on the row.
                  installCommand: undefined,
                }, ...options?.storedJob };
              return { data: !options?.readError && filters.every(f => f(row)) ? row : null,
                error: options?.readError ? { message: 'synthetic private read error' } : null };
            },
          };
          return query;
        } };
      }

      if (table === 'user_settings') {
        const settingsChain: Record<string, ChainFn> = {
          select: vi.fn(),
          eq: vi.fn(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: options?.userSettings ? { settings: options.userSettings } : null,
            error: null,
          }),
        };
        for (const key of Object.keys(settingsChain)) {
          if (key !== 'maybeSingle') {
            settingsChain[key].mockReturnValue(settingsChain);
          }
        }
        return { select: settingsChain.select };
      }

      throw new Error(`Unexpected table used in test: ${table}`);
    },
  };

  return {
    supabase,
    policyUpdatePayloads,
  };
}

describe('POST /api/updates/trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    isSupabaseConfiguredMock.mockReturnValue(true);
    getDatabaseMock.mockReturnValue({
      updateCheckResults: { getByUserId: getDetectedUpdatesMock },
      uploadHistory: {
        getByUserIdAndTenantId: getHistoryMock,
        // Provenance is a tenant fact, not a per-user one: an app a
        // colleague deployed is still an IntuneGet app.
        getByTenantId: getHistoryMock,
      },
      jobs: { create: createJobMock },
      userSettings: { get: getUserSettingsMock },
      updatePolicies: { getForWingetIds: getPoliciesMock },
    });
    getPoliciesMock.mockResolvedValue([]);
    getUserSettingsMock.mockResolvedValue(null);
    getDetectedUpdatesMock.mockResolvedValue([]);
    getHistoryMock.mockResolvedValue([]);
    createJobMock.mockResolvedValue({ id: 'job-new' });

    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      // The same tenant the request bodies below name: a plain user may only
      // deploy into their own, which the foreign-tenant test covers.
      tenantId: 'tenant-1',
      userName: 'User',
    });
    resolveTargetTenantIdMock.mockImplementation(allowRequestedTenant);
  });

  it('refuses the whole request when one of the named tenants is not the caller\'s to deploy to', async () => {
    parseAccessTokenMock.mockResolvedValue({ userId: 'user-1', userEmail: 'user@example.com', tenantId: 'home-tenant', userName: 'User' });
    const from = vi.fn(() => {
      throw new Error('no table may be touched before authorization');
    });
    createServerClientMock.mockReturnValue({ from });
    resolveTargetTenantIdMock.mockImplementation(async ({ requestedTenantId }: { requestedTenantId: string }) =>
      requestedTenantId === 'someone-elses-tenant'
        ? { tenantId: 'home-tenant', errorResponse: NextResponse.json({ error: 'Not authorized to access other tenants' }, { status: 403 }) }
        : { tenantId: requestedTenantId, errorResponse: null }
    );

    const response = await POST(
      new NextRequest('http://localhost:3000/api/updates/trigger', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: [
            { winget_id: 'Vendor.One', tenant_id: 'tenant-1' },
            { winget_id: 'Vendor.Two', tenant_id: 'someone-elses-tenant' },
          ],
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(triggerAutoUpdateMock).not.toHaveBeenCalled();
    expect(triggerPackagingWorkflowMock).not.toHaveBeenCalled();
    expect(resolveTargetTenantIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestedTenantId: 'tenant-1', requiredPermission: 'deploy_apps', tokenTenantId: 'home-tenant' })
    );
  });

  it('leaves stored policy fields untouched when installer lookup fails', async () => {
    const policy: AppUpdatePolicy = {
      id: 'policy-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      winget_id: 'Microsoft.Edge',
      policy_type: 'notify',
      pinned_version: null,
      deployment_config: null,
      original_upload_history_id: null,
      last_auto_update_at: null,
      last_auto_update_version: null,
      is_enabled: false,
      consecutive_failures: 0,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    };

    const { supabase, policyUpdatePayloads } = createTriggerSupabaseMocks(policy);
    createServerClientMock.mockReturnValue(supabase);
    const failureMessage = 'The catalog has not synced the installer manifest for Microsoft.Edge 2.0.0 yet. Try again after the next catalog sync.';
    getLatestInstallerInfoMock.mockResolvedValue({
      ok: false,
      failure: {
        reason: 'version_record_missing',
        message: failureMessage,
      },
    });

    const request = new NextRequest('http://localhost:3000/api/updates/trigger', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toBe(failureMessage);
    expect(policyUpdatePayloads).toEqual([]);
  });

  it('leaves stored policy fields untouched when trigger throws', async () => {
    const policy: AppUpdatePolicy = {
      id: 'policy-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      winget_id: 'Microsoft.Edge',
      policy_type: 'notify',
      pinned_version: null,
      deployment_config: null,
      original_upload_history_id: null,
      last_auto_update_at: null,
      last_auto_update_version: null,
      is_enabled: false,
      consecutive_failures: 0,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    };

    const { supabase, policyUpdatePayloads } = createTriggerSupabaseMocks(policy);
    createServerClientMock.mockReturnValue(supabase);
    getLatestInstallerInfoMock.mockResolvedValue({
      ok: true,
      info: { currentVersion: '' },
    });
    triggerAutoUpdateMock.mockRejectedValue(new Error('trigger crashed'));

    const request = new NextRequest('http://localhost:3000/api/updates/trigger', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toContain('trigger crashed');
    expect(policyUpdatePayloads).toEqual([]);
  });

  it('preserves stored manual policy settings and never dispatches when fixed rules hold the update', async () => {
    const policy = {id:'policy-1',user_id:'user-1',tenant_id:'tenant-1',winget_id:'Microsoft.Edge',policy_type:'notify',is_enabled:false,consecutive_failures:0,deployment_config:{architecture:'x64',psadtConfig:{customDetection:true}},original_upload_history_id:null} as AppUpdatePolicy;
    const {supabase,policyUpdatePayloads}=createTriggerSupabaseMocks(policy);
    createServerClientMock.mockReturnValue(supabase);
    getLatestInstallerInfoMock.mockResolvedValue({ok:true,info:{wingetId:'Microsoft.Edge',currentVersion:'',latestVersion:'2.0.0'}});
    triggerAutoUpdateMock.mockResolvedValue({success:false,skipped:true,skipReason:'Custom detection rules are fixed. Deploy 2.0.0 from the catalog with updated rules.'});
    const response=await POST(new NextRequest('http://localhost:3000/api/updates/trigger',{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:JSON.stringify({winget_id:'Microsoft.Edge',tenant_id:'tenant-1'})}));
    expect((await response.json()).results[0]).toMatchObject({success:false,skipped:true});
    expect(policyUpdatePayloads).toEqual([]);
    expect(triggerPackagingWorkflowMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('runs a paused automatic policy once without enabling stored state, trigger failure: %s', async fails => {
    const policy = { id: 'policy-1', user_id: 'user-1', tenant_id: 'tenant-1',
      winget_id: 'Microsoft.Edge', policy_type: 'auto_update', is_enabled: false,
      consecutive_failures: 3, deployment_config: { architecture: 'x64' },
      original_upload_history_id: null } as AppUpdatePolicy;
    const { supabase, policyUpdatePayloads } = createTriggerSupabaseMocks(policy);
    createServerClientMock.mockReturnValue(supabase);
    getLatestInstallerInfoMock.mockResolvedValue({ ok: true, info: {
      wingetId: 'Microsoft.Edge', currentVersion: '', latestVersion: '2.0.0' } });
    triggerAutoUpdateMock.mockImplementation(async (attempt: AppUpdatePolicy) => {
      expect(canAutoUpdate(attempt)).toBe(true);
      expect(attempt.consecutive_failures).toBe(0);
      if (fails) throw new Error('synthetic trigger failure');
      return { success: true, packagingJobId: 'manual-job' };
    });
    getFeatureFlagsMock.mockReturnValue({ localPackager: true });
    const response = await POST(new NextRequest('http://localhost:3000/api/updates/trigger', {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1' }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).triggered).toBe(fails ? 0 : 1);
    expect(triggerAutoUpdateMock).toHaveBeenCalledOnce();
    expect(policyUpdatePayloads).toEqual([]);
    expect(policy).toMatchObject({ policy_type: 'auto_update', is_enabled: false, consecutive_failures: 3 });
  });

  it('returns an explicit skipped result when auto-update is blocked by current QA', async () => {
    const policy: AppUpdatePolicy = {
      id: 'policy-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      winget_id: 'Microsoft.Edge',
      policy_type: 'auto_update',
      pinned_version: null,
      deployment_config: { architecture: 'x64' } as DeploymentConfig,
      original_upload_history_id: null,
      last_auto_update_at: null,
      last_auto_update_version: null,
      is_enabled: true,
      consecutive_failures: 0,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    };

    const { supabase } = createTriggerSupabaseMocks(policy);
    createServerClientMock.mockReturnValue(supabase);
    getLatestInstallerInfoMock.mockResolvedValue({
      ok: true,
      info: {
        wingetId: 'Microsoft.Edge',
        currentVersion: '',
        latestVersion: '2.0.0',
      },
    });
    triggerAutoUpdateMock.mockResolvedValue({
      success: false,
      skipped: true,
      code: 'QA_FAILED_CURRENT_VERSION',
      skipReason: 'QA failed; correct the uninstall command and rerun QA.',
    });

    const response = await POST(new NextRequest('http://localhost:3000/api/updates/trigger', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1' }),
    }));
    const body = await response.json();

    expect(body).toMatchObject({
      success: false,
      failed: 1,
      results: [{
        success: false,
        skipped: true,
        code: 'QA_FAILED_CURRENT_VERSION',
      }],
    });
    expect(triggerPackagingWorkflowMock).not.toHaveBeenCalled();
  });

  it('forwards stored relationships and auto-supersedence to the packaging workflow', async () => {
    const relationships = [
      {
        relationshipType: 'dependency' as const,
        targetId: 'dep-app-1',
        targetDisplayName: 'Dependency App',
        dependencyType: 'autoInstall' as const,
      },
    ];

    const deploymentConfig: DeploymentConfig = {
      displayName: 'Microsoft Edge',
      publisher: 'Microsoft',
      architecture: 'x64',
      installerType: 'exe',
      installCommand: 'setup.exe /silent',
      uninstallCommand: '',
      installScope: 'system',
      detectionRules: [],
      assignments: [],
      relationships,
    };

    const policy: AppUpdatePolicy = {
      id: 'policy-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      winget_id: 'Microsoft.Edge',
      policy_type: 'auto_update',
      pinned_version: null,
      deployment_config: deploymentConfig,
      original_upload_history_id: null,
      last_auto_update_at: null,
      last_auto_update_version: null,
      is_enabled: true,
      consecutive_failures: 0,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    };

    const { supabase } = createTriggerSupabaseMocks(policy, {
      latestUploadIntuneAppId: 'prev-app-1',
      userSettings: { carryOverAssignments: true, supersedePreviousApp: true },
    });
    createServerClientMock.mockReturnValue(supabase);
    getLatestInstallerInfoMock.mockResolvedValue({
      ok: true,
      info: {
        wingetId: 'Microsoft.Edge',
        currentVersion: '',
        latestVersion: '2.0.0',
        displayName: 'Microsoft Edge',
        installerUrl: 'https://example.com/edge.exe',
        installerSha256: 'abc123',
        installerType: 'exe',
        installerSuccessCodes: [0, 3010],
      },
    });
    triggerAutoUpdateMock.mockResolvedValue({
      success: true,
      packagingJobId: 'pkg-job-1',
    });
    getFeatureFlagsMock.mockReturnValue({ pipeline: true, localPackager: false });
    isGitHubActionsConfiguredMock.mockReturnValue(true);
    getAppConfigMock.mockReturnValue({ app: { url: 'http://localhost:3000' } });
    triggerPackagingWorkflowMock.mockResolvedValue({ success: true });

    const request = new NextRequest('http://localhost:3000/api/updates/trigger', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.triggered).toBe(1);
    expect(triggerPackagingWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerPackagingWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'pkg-job-1',
        installerSuccessCodes: [0, 3010],
        relationships: JSON.stringify(relationships),
        sourceIntuneAppId: 'prev-app-1',
        carryOverAssignments: true,
        removeAssignmentsFromPreviousApp: false,
        autoSupersede: true,
        supersedenceType: 'update',
      }),
      undefined,
      expect.any(Object)
    );
  });

  it('does not request auto-supersedence when the user setting is off', async () => {
    const policy: AppUpdatePolicy = {
      id: 'policy-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      winget_id: 'Microsoft.Edge',
      policy_type: 'auto_update',
      pinned_version: null,
      deployment_config: {
        displayName: 'Microsoft Edge',
        publisher: 'Microsoft',
        architecture: 'x64',
        installerType: 'exe',
        installCommand: 'setup.exe /silent',
        uninstallCommand: '',
        installScope: 'system',
        detectionRules: [],
        assignments: [],
      } as DeploymentConfig,
      original_upload_history_id: null,
      last_auto_update_at: null,
      last_auto_update_version: null,
      is_enabled: true,
      consecutive_failures: 0,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    };

    const { supabase } = createTriggerSupabaseMocks(policy, {
      latestUploadIntuneAppId: 'prev-app-1',
    });
    createServerClientMock.mockReturnValue(supabase);
    getLatestInstallerInfoMock.mockResolvedValue({
      ok: true,
      info: {
        wingetId: 'Microsoft.Edge',
        currentVersion: '',
        latestVersion: '2.0.0',
        displayName: 'Microsoft Edge',
        installerUrl: 'https://example.com/edge.exe',
        installerSha256: 'abc123',
        installerType: 'exe',
      },
    });
    triggerAutoUpdateMock.mockResolvedValue({
      success: true,
      packagingJobId: 'pkg-job-2',
    });
    getFeatureFlagsMock.mockReturnValue({ pipeline: true, localPackager: false });
    isGitHubActionsConfiguredMock.mockReturnValue(true);
    getAppConfigMock.mockReturnValue({ app: { url: 'http://localhost:3000' } });
    triggerPackagingWorkflowMock.mockResolvedValue({ success: true });

    const request = new NextRequest('http://localhost:3000/api/updates/trigger', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(triggerPackagingWorkflowMock).toHaveBeenCalledTimes(1);
    const workflowInputs = triggerPackagingWorkflowMock.mock.calls[0][0];
    expect(workflowInputs.autoSupersede).toBe(false);
    expect(workflowInputs.supersedenceType).toBeUndefined();
    expect(workflowInputs.relationships).toBeUndefined();
  });
  describe('without Supabase (DATABASE_MODE=sqlite self-hosting)', () => {
    const detectedUpdate = {
      id: 'upd-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      winget_id: 'Mozilla.Firefox',
      intune_app_id: 'stale-app-id',
      display_name: 'Mozilla Firefox',
      current_version: '152.0.1',
      latest_version: '152.0.5',
      is_critical: false,
      is_managed: false,
      large_icon_type: null,
      large_icon_value: null,
      notified_at: null,
      dismissed_at: null,
      detected_at: '2026-08-03T10:00:00Z',
      updated_at: '2026-08-03T10:00:00Z',
    };

    const deploymentConfig = {
      displayName: 'Mozilla Firefox',
      publisher: 'Mozilla',
      architecture: 'x64',
      installerType: 'exe',
      installCommand: 'setup.exe /S',
      uninstallCommand: 'helper.exe /S',
      installScope: 'system',
      detectionRules: [{ type: 'registry' }],
      assignments: [{ type: 'group', groupId: 'g-1' }],
      categories: [],
      forceCreateNewApp: true,
    } as unknown as DeploymentConfig;

    beforeEach(() => {
      isSupabaseConfiguredMock.mockReturnValue(false);
      parseAccessTokenMock.mockResolvedValue({
        userId: 'user-1',
        userEmail: 'user@example.com',
        tenantId: 'tenant-1',
        userName: 'User',
      });
      getFeatureFlagsMock.mockReturnValue({ localPackager: true });
      getDetectedUpdatesMock.mockResolvedValue([detectedUpdate]);
      buildDeploymentConfigForAppMock.mockResolvedValue({
        status: 'ok',
        deploymentConfig,
        originalUploadHistoryId: 'upload-1',
      });
      getLatestInstallerInfoMock.mockResolvedValue({
        ok: true,
        info: {
          wingetId: 'Mozilla.Firefox',
          currentVersion: '152.0.1',
          latestVersion: '152.0.5',
          displayName: 'Mozilla Firefox',
          installerUrl: 'https://example.com/firefox.exe',
          installerSha256: 'a'.repeat(64),
          installerType: 'exe',
        },
      });
    });

    function triggerRequest(overrides: Partial<{ winget_id: string; tenant_id: string }> = {}) {
      const request = new NextRequest('http://localhost:3000/api/updates/trigger', {
        method: 'POST',
        body: JSON.stringify({
          winget_id: overrides.winget_id ?? 'Mozilla.Firefox',
          tenant_id: overrides.tenant_id ?? 'tenant-1',
        }),
      });
      request.headers.set('Authorization', 'Bearer test-token');
      return request;
    }

    it('queues a packaging job instead of refusing with a 503', async () => {
      // Regression: this route answered 503 "Update deployment requires
      // Supabase" for every request, so the Update button in a self-hosted
      // install could never do anything. A manual trigger needs no policy and
      // no auto-update bookkeeping - only a queued job for the local packager.
      const response = await POST(triggerRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.triggered).toBe(1);
      expect(body.results[0].packaging_job_id).toBe('job-new');
      expect(createServerClientMock).not.toHaveBeenCalled();

      const job = createJobMock.mock.calls[0][0];
      expect(job).toMatchObject({
        user_id: 'user-1',
        tenant_id: 'tenant-1',
        winget_id: 'Mozilla.Firefox',
        version: '152.0.5',
        installer_url: 'https://example.com/firefox.exe',
        status: 'queued',
      });
      expect(job.package_config.assignments).toEqual([
        { type: 'group', groupId: 'g-1' },
      ]);
    });

    it('rejects body tenant IDs outside the signed-in SQLite tenant', async () => {
      const body = await (await POST(triggerRequest({ tenant_id: 'other-tenant' }))).json();

      expect(body.success).toBe(false);
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/signed-in tenant/i);
      expect(getDetectedUpdatesMock).not.toHaveBeenCalled();
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('prefers the newest deployment over a stale detected app id', async () => {
      getHistoryMock.mockResolvedValue([
        { winget_id: 'Mozilla.Firefox', intune_app_id: 'current-app-id' },
        { winget_id: 'Mozilla.Firefox', intune_app_id: 'older-app-id' },
      ]);

      await POST(triggerRequest());

      const job = createJobMock.mock.calls[0][0];
      expect(job.package_config.sourceIntuneAppId).toBe('current-app-id');
    });

    it('falls back to the detected app id when there is no deployment history', async () => {
      getHistoryMock.mockResolvedValue([]);

      await POST(triggerRequest());

      const job = createJobMock.mock.calls[0][0];
      expect(job.package_config.sourceIntuneAppId).toBe('stale-app-id');
    });

    it('reports an unknown app instead of queueing a job for it', async () => {
      getDetectedUpdatesMock.mockResolvedValue([]);

      const body = await (await POST(triggerRequest())).json();

      expect(body.success).toBe(false);
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toBe('Update not found');
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('refuses when no local packager would pick the job up', async () => {
      // Queueing here would leave the job sitting in 'queued' forever with no
      // indication to the user that nothing is going to run it.
      getFeatureFlagsMock.mockReturnValue({ localPackager: false });

      const body = await (await POST(triggerRequest())).json();

      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/local packager/);
      expect(createJobMock).not.toHaveBeenCalled();
    });
    it('carries assignments over and supersedes when the user enabled both', async () => {
      // Regression: these two settings live in user_settings, which the
      // Supabase-less path did not read - it hardcoded carry-over to false and
      // omitted autoSupersede entirely. The result in Intune was both versions
      // assigned and the old app not marked as superseded, which is exactly
      // what the toggles are there to prevent.
      getUserSettingsMock.mockResolvedValue({
        carryOverAssignments: true,
        supersedePreviousApp: true,
      });
      getHistoryMock.mockResolvedValue([
        { winget_id: 'Mozilla.Firefox', intune_app_id: 'current-app-id' },
      ]);

      await POST(triggerRequest());

      const job = createJobMock.mock.calls[0][0];
      expect(job.package_config).toMatchObject({
        autoSupersede: true,
        supersedenceType: 'update',
        sourceIntuneAppId: 'current-app-id',
        assignmentMigration: {
          carryOverAssignments: true,
          removeAssignmentsFromPreviousApp: true,
        },
      });
    });

    it('leaves the previous app alone when the user disabled both', async () => {
      getUserSettingsMock.mockResolvedValue({
        carryOverAssignments: false,
        supersedePreviousApp: false,
      });

      await POST(triggerRequest());

      const job = createJobMock.mock.calls[0][0];
      expect(job.package_config.autoSupersede).toBe(false);
      expect(job.package_config.supersedenceType).toBeUndefined();
      expect(job.package_config.assignmentMigration).toEqual({
        carryOverAssignments: false,
        removeAssignmentsFromPreviousApp: false,
      });
    });

    it('does not claim supersedence when there is no app to supersede', async () => {
      // Nothing to point at: the detected result has no app id either.
      getUserSettingsMock.mockResolvedValue({ supersedePreviousApp: true });
      getHistoryMock.mockResolvedValue([]);
      getDetectedUpdatesMock.mockResolvedValue([
        { ...detectedUpdate, intune_app_id: '' },
      ]);

      await POST(triggerRequest());

      const job = createJobMock.mock.calls[0][0];
      expect(job.package_config.autoSupersede).toBe(false);
      expect(job.package_config.supersedenceType).toBeUndefined();
    });

    it('passes the allow-available-uninstall setting to the packager', async () => {
      // The setting is global rather than per assignment, so it rides along in
      // package_config and the packager stamps it onto available assignments.
      getUserSettingsMock.mockResolvedValue({ allowAvailableUninstall: true });

      await POST(triggerRequest());

      expect(createJobMock.mock.calls[0][0].package_config.allowAvailableUninstall).toBe(true);
    });

    it('defaults allow-available-uninstall to false when never saved', async () => {
      getUserSettingsMock.mockResolvedValue(null);

      await POST(triggerRequest());

      expect(createJobMock.mock.calls[0][0].package_config.allowAvailableUninstall).toBe(false);
    });

    it('refuses to deploy an app the operator set to ignore', async () => {
      // The Updates page already leaves ignored apps out of "Update All", but
      // the policy has to hold at the trigger too: a stale page or a direct
      // API call must not be able to push a version past it.
      getPoliciesMock.mockResolvedValue([
        {
          id: 'pol-1',
          winget_id: 'Mozilla.Firefox',
          tenant_id: 'tenant-1',
          policy_type: 'ignore',
          is_enabled: true,
          pinned_version: null,
        },
      ]);

      const body = await (await POST(triggerRequest())).json();

      expect(body.triggered).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/ignore/i);
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('refuses to deploy a version the app is pinned away from', async () => {
      getPoliciesMock.mockResolvedValue([
        {
          id: 'pol-1',
          winget_id: 'Mozilla.Firefox',
          tenant_id: 'tenant-1',
          policy_type: 'pin_version',
          is_enabled: true,
          pinned_version: '152.0.1',
        },
      ]);

      const body = await (await POST(triggerRequest())).json();

      expect(body.triggered).toBe(0);
      expect(body.results[0].error).toContain('152.0.1');
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('deploys when the pin names the version being offered', async () => {
      // Pinning to the version that is actually rolling out is not a block:
      // shouldSkipUpdate only holds back versions other than the pinned one.
      getPoliciesMock.mockResolvedValue([
        {
          id: 'pol-1',
          winget_id: 'Mozilla.Firefox',
          tenant_id: 'tenant-1',
          policy_type: 'pin_version',
          is_enabled: true,
          pinned_version: '152.0.5',
        },
      ]);

      const body = await (await POST(triggerRequest())).json();

      expect(body.triggered).toBe(1);
      expect(createJobMock).toHaveBeenCalled();
    });

    it('composes the description into the job for the local packager', async () => {
      // Same gap as the deployment route: the packager reads this field out of
      // package_config, so composing it at dispatch never reached it.
      getUserSettingsMock.mockResolvedValue({ appDescriptionSuffix: 'by IT' });

      await POST(triggerRequest());

      const config = createJobMock.mock.calls[0][0].package_config as {
        description: string;
      };
      expect(config.description).toContain('by IT');
      expect(config.description).not.toContain('Winget:');
      expect(config.description).not.toContain('IntuneGet.com');
    });

    it('deploys normally when a notify policy is set', async () => {
      getPoliciesMock.mockResolvedValue([
        {
          id: 'pol-1',
          winget_id: 'Mozilla.Firefox',
          tenant_id: 'tenant-1',
          policy_type: 'notify',
          is_enabled: true,
          pinned_version: null,
        },
      ]);

      const body = await (await POST(triggerRequest())).json();

      expect(body.triggered).toBe(1);
    });

    it('applies the current carry-over setting when the deployment stored no choice', async () => {
      // The builder no longer takes the global value: it only reports an
      // explicit per-app choice, so the live setting is applied here instead
      // of being frozen into the stored config.
      getUserSettingsMock.mockResolvedValue({ carryOverAssignments: true });

      await POST(triggerRequest());

      expect(createJobMock.mock.calls[0][0].package_config.assignmentMigration).toEqual({
        carryOverAssignments: true,
        removeAssignmentsFromPreviousApp: true,
      });
    });

    it('lets an explicit per-app choice win over the global carry-over setting', async () => {
      getUserSettingsMock.mockResolvedValue({ carryOverAssignments: true });
      buildDeploymentConfigForAppMock.mockResolvedValue({
        status: 'ok',
        deploymentConfig: {
          ...deploymentConfig,
          assignmentMigration: {
            carryOverAssignments: false,
            removeAssignmentsFromPreviousApp: false,
          },
        },
        originalUploadHistoryId: 'upload-1',
      });

      await POST(triggerRequest());

      expect(createJobMock.mock.calls[0][0].package_config.assignmentMigration).toEqual({
        carryOverAssignments: false,
        removeAssignmentsFromPreviousApp: false,
      });
    });
  });
  it.each(['503', 'network', 'miss', 'write error', 'stored custom', 'custom', 'missing pin', 'invalid pin', 'rate limit', 'rate limit no pin', 'rate limit invalid pin', 'rate limit custom', 'rate limit miss', 'rate limit write error', 'batch', 'awaiting QA'])('handles a manual update dispatch with %s safely', async kind => {
    const policy: AppUpdatePolicy = {
      id: 'policy-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      winget_id: 'Microsoft.Edge',
      policy_type: 'auto_update',
      pinned_version: null,
      deployment_config: {
        displayName: 'Microsoft Edge',
        publisher: 'Microsoft',
        architecture: 'x64',
        installerType: 'exe',
        installCommand: 'setup.exe /silent',
        uninstallCommand: '',
        installScope: 'system',
        detectionRules: [],
        assignments: [],
      } as DeploymentConfig,
      original_upload_history_id: null,
      last_auto_update_at: null,
      last_auto_update_version: null,
      is_enabled: true,
      consecutive_failures: 0,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    };

    const { supabase } = createTriggerSupabaseMocks(policy, {
      latestUploadIntuneAppId: 'prev-app-1',
    });
    if (['stored custom', 'rate limit custom'].includes(kind)) policy.deployment_config = { ...policy.deployment_config, sourceType: 'custom' } as DeploymentConfig;
    const writes: Array<{ table: string; patch: Record<string, unknown>; guards: Record<string, unknown> }> = [];
    const from = supabase.from;
    supabase.from = ((table: string) => {
      if (!['packaging_jobs', 'auto_update_history'].includes(table)) return from(table);
      return { ...(table === 'packaging_jobs' ? from(table) : {}), update: (patch: Record<string, unknown>) => {
        const guards: Record<string, unknown> = {};
        writes.push({ table, patch, guards });
        const result = { data: ['miss', 'rate limit miss'].includes(kind) ? null : { id: 'pkg-job-2' }, error: ['write error', 'rate limit write error'].includes(kind) ? { message: 'synthetic write failure' } : null };
        const query = {
          eq: (key: string, value: unknown) => { guards[key] = value; return query; },
          is: (key: string, value: unknown) => { guards[key] = value; return query; },
          in: (key: string, value: unknown) => { guards[key] = value; return query; },
          select: () => query, maybeSingle: vi.fn(async () => {
            const status = kind === 'awaiting QA' ? 'awaiting_qa' : 'queued';
            const accepted = Array.isArray(guards.status) ? guards.status.includes(status) : guards.status === status;
            return accepted ? result : { data: null, error: null };
          }),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
        };
        return query;
      } };
    }) as typeof supabase.from;
    createServerClientMock.mockReturnValue(supabase);
    getLatestInstallerInfoMock.mockResolvedValue({
      ok: true,
      info: {
        sourceType: kind === 'custom' ? 'custom' : undefined,
        wingetId: 'Microsoft.Edge',
        currentVersion: '',
        latestVersion: '2.0.0',
        displayName: 'Microsoft Edge',
        installerUrl: 'https://example.com/edge.exe',
        installerSha256: 'abc123',
        installerType: 'exe',
      },
    });
    triggerAutoUpdateMock.mockResolvedValue({
      success: true,
      packagingJobId: 'pkg-job-2', historyId: 'history-2',
    });
    getFeatureFlagsMock.mockReturnValue({ pipeline: true, localPackager: false });
    isGitHubActionsConfiguredMock.mockReturnValue(true);
    getAppConfigMock.mockReturnValue({ app: { url: 'http://localhost:3000' } });
    const error = kind.startsWith('rate limit')
      ? Object.assign(new WorkflowDispatchRateLimitError(429, new Date(Date.now() + 60_000).toISOString()), { dispatchIdentity: kind === 'rate limit no pin' ? undefined : kind === 'rate limit invalid pin' ? 'bad' : 'a'.repeat(64) })
      : new WorkflowDispatchUnconfirmedError(kind === 'network' ? null : 503, Date.now(), kind === 'missing pin' ? undefined : kind === 'invalid pin' ? 'bad' : 'a'.repeat(64));
    triggerPackagingWorkflowMock.mockRejectedValue(error);
    if (kind === 'batch') {
      triggerAutoUpdateMock.mockResolvedValueOnce({ success: true, packagingJobId: 'pkg-job-2', historyId: 'history-2' })
        .mockResolvedValueOnce({ success: true, packagingJobId: 'pkg-job-3', historyId: 'history-3' });
      triggerPackagingWorkflowMock.mockRejectedValueOnce(error).mockResolvedValueOnce({ success: true });
    }

    const request = new NextRequest('http://localhost:3000/api/updates/trigger', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(kind === 'batch' ? { updates: [{ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1' }, { winget_id: 'Microsoft.Edge', tenant_id: 'tenant-2' }] } : { winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1' }),
      }),
    });

    const requestedAt = Date.now();
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(triggerPackagingWorkflowMock).toHaveBeenCalledTimes(kind === 'batch' ? 2 : 1);
    expect(triggerPackagingWorkflowMock.mock.calls[0][2]).toMatchObject({ requireQaPass: true, newJobAdmission: !['stored custom', 'custom', 'rate limit custom'].includes(kind) });
    const body = await response.json();
    const terminal = ['stored custom', 'custom', 'missing pin', 'invalid pin', 'rate limit no pin', 'rate limit invalid pin', 'rate limit custom'].includes(kind);
    expect(writes[0]).toMatchObject({ table: 'packaging_jobs', guards: {
      id: 'pkg-job-2', github_run_id: null, callback_run_id: null,
      cancelled_at: null, archived_at: null, error_details: null,
    } });
    if (terminal) {
      expect(writes[0].patch).toMatchObject({ status: 'failed', error_code: error.code });
      expect(writes[0].patch.error_details).toBeUndefined();
      expect(writes[1]).toMatchObject({ table: 'auto_update_history', patch: { status: 'failed' }, guards: { id: 'history-2' } });
      expect(body.failed).toBe(1);
    } else {
      expect(writes).toHaveLength(1);
      expect(writes[0].patch).toMatchObject({ status: 'awaiting_qa', completed_at: null, error_code: error.code,
        error_details: { workflow_dispatch_unconfirmed_identity: 'a'.repeat(64), workflow_dispatch_rate_limit_attempts: 1 } });
      expect(Date.parse(writes[0].patch.qa_resume_due_at as string)).toBeGreaterThanOrEqual(requestedAt + 60_000);
      const success = ['503', 'network', 'batch', 'awaiting QA', 'rate limit'].includes(kind);
      expect(body.failed).toBe(success ? 0 : 1);
      expect(body.triggered).toBe(kind === 'batch' ? 2 : success ? 1 : 0);
      if (success) expect(body.results[0]).toMatchObject({ success: true, packaging_job_id: 'pkg-job-2', code: error.code });
      else expect(body.results[0].error).toMatch(['miss', 'rate limit miss'].includes(kind) ? /status changed/ : /Could not schedule/);
    }
  });

  it.each(['user_id', 'tenant_id', 'auto_update_policy_id', 'is_auto_update', 'status',
    'github_run_id', 'callback_run_id', 'cancelled_at', 'archived_at', 'read error', 'read error lost', 'read error write error'])
  ('does not dispatch a stored job with a changed ownership guard: %s', async field => {
    const policy = { id: 'policy-1', user_id: 'user-1', tenant_id: 'tenant-1', winget_id: 'Microsoft.Edge',
      policy_type: 'auto_update', is_enabled: true, deployment_config: {} } as AppUpdatePolicy;
    const { supabase, policyUpdatePayloads } = createTriggerSupabaseMocks(policy, {
      storedJob: field.startsWith('read error') ? {} : { [field]: field === 'is_auto_update' ? false : 'changed' },
      readError: field.startsWith('read error'),
    });
    const writes: Array<{ table: string; patch: Record<string, unknown> }> = [];
    const from = supabase.from;
    const policyFilters: Record<string, unknown> = {};
    supabase.from = ((table: string) => {
      if (table === 'app_update_policies') return { ...from(table), update: (patch: Record<string, unknown>) => {
        policyUpdatePayloads.push(patch);
        const query = { eq: (key: string, value: unknown) => { policyFilters[key] = value; return query; },
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
        return query;
      } };
      if (!['packaging_jobs', 'auto_update_history'].includes(table)) return from(table);
      return { ...(table === 'packaging_jobs' ? from(table) : {}), update: (patch: Record<string, unknown>) => {
        writes.push({ table, patch });
        const query = { eq: () => query, is: () => query, in: () => query, select: () => query,
          maybeSingle: async () => ({ data: field === 'read error lost' ? null : { id: 'job-guard' }, error: field === 'read error write error' ? { message: 'synthetic write error' } : null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
        return query;
      } };
    }) as typeof supabase.from;
    createServerClientMock.mockReturnValue(supabase);
    triggerAutoUpdateMock.mockResolvedValue({ success: true, packagingJobId: 'job-guard', historyId: 'history-guard' });
    getLatestInstallerInfoMock.mockResolvedValue({ ok: true, info: { latestVersion: '2.0.0' } });
    getFeatureFlagsMock.mockReturnValue({ localPackager: false });
    isGitHubActionsConfiguredMock.mockReturnValue(true);
    getAppConfigMock.mockReturnValue({ app: { url: 'https://example.test' } });
    const response = await POST(new NextRequest('https://example.test/api/updates/trigger', {
      method: 'POST', headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({ updates: [{ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1' }] }),
    }));
    const body = await response.json();
    expect(body).toMatchObject({ failed: 1, triggered: 0 });
    expect(triggerPackagingWorkflowMock).not.toHaveBeenCalled();
    expect(writes.map(w => [w.table, w.patch.status])).toEqual(field === 'read error'
      ? [['packaging_jobs', 'failed'], ['auto_update_history', 'failed']] : field.startsWith('read error') ? [['packaging_jobs', 'failed']] : []);
    expect(response.status).toBe(200);
    if (field === 'read error') {
      expect(policyUpdatePayloads).toContainEqual(expect.objectContaining({ last_auto_update_version: null }));
      expect(policyFilters).toEqual({ id: 'policy-1', user_id: 'user-1', tenant_id: 'tenant-1', last_auto_update_version: '2.0.0' });
    } else expect(policyUpdatePayloads).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('synthetic private');
  });


  it.each(['lost', 'won', 'claim error', '503', 'custom 503', '429', '429 no pin', '429 invalid pin', 'custom 429', '429 lost', '400', 'queued', 'gate stale'])('guards the manual dispatch claim: %s', async mode => {
    const policy = { id: 'policy-1', user_id: 'user-1', tenant_id: 'tenant-1', winget_id: 'Microsoft.Edge',
      policy_type: 'auto_update', is_enabled: true, deployment_config: {} } as AppUpdatePolicy;
    const row: Record<string, unknown> = { id: 'job-race', user_id: 'user-1', tenant_id: 'tenant-1',
      auto_update_policy_id: 'policy-1', is_auto_update: true, status: mode === 'queued' ? 'queued' : 'awaiting_qa',
      qa_resume_due_at: '2026-01-01T00:00:00Z', qa_candidate_id: 'candidate', installer_sha256: 'a'.repeat(64), architecture: 'x64' };
    const { supabase } = createTriggerSupabaseMocks(policy, { storedJob: { ...row } });
    const from = supabase.from;
    const writes: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown>; won: boolean }> = [];
    supabase.from = ((table: string) => {
      if (table !== 'packaging_jobs') return from(table);
      return { ...from(table), update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const predicates: Array<() => boolean> = [];
        const query = {
          eq: (k: string, v: unknown) => { filters[k] = v; predicates.push(() => row[k] === v); return query; },
          is: (k: string, v: unknown) => { filters[k] = v; predicates.push(() => (row[k] ?? null) === v); return query; },
          in: (k: string, v: unknown[]) => { filters[k] = v; predicates.push(() => v.includes(row[k])); return query; },
          select: () => query,
          maybeSingle: async () => {
            if (mode === 'claim error') return { data: null, error: { message: 'synthetic claim error' } };
            const won = predicates.every(f => f());
            writes.push({ patch, filters, won });
            if (won) Object.assign(row, patch);
            return { data: won ? { id: row.id } : null, error: null };
          },
        };
        return query;
      } };
    }) as typeof supabase.from;
    createServerClientMock.mockReturnValue(supabase);
    triggerAutoUpdateMock.mockResolvedValue({ success: true, packagingJobId: 'job-race' });
    getLatestInstallerInfoMock.mockResolvedValue({ ok: true, info: { latestVersion: '2.0.0', displayName: 'Microsoft Edge',
      installerUrl: 'https://example.test/edge.exe', installerSha256: 'a'.repeat(64), installerType: 'exe',
      sourceType: mode.startsWith('custom ') ? 'custom' : 'winget' } });
    getFeatureFlagsMock.mockReturnValue({ localPackager: false });
    isGitHubActionsConfiguredMock.mockReturnValue(true);
    getAppConfigMock.mockReturnValue({ app: { url: 'https://example.test' } });
    let posts = 0;
    triggerPackagingWorkflowMock.mockImplementation(async (_inputs, _ref, options) => {
      if (mode === 'gate stale') {
        row.status = 'packaging';
        throw new QaGateNotPassedError({ wingetId: 'Microsoft.Edge', version: '2.0.0', architecture: 'x64',
          installerSha256: 'a'.repeat(64), packageProfileSha256: 'b'.repeat(64), reason: 'missing' });
      }
      if (mode === 'lost') row.status = 'packaging'; // cron wins during preparation
      await options?.beforeDispatch?.({} as never);
      expect(row.status).toBe(mode === 'queued' ? 'queued' : 'packaging');
      posts++;
      if (mode.includes('503')) throw new WorkflowDispatchUnconfirmedError(503, Date.now(), 'b'.repeat(64));
      if (mode.includes('429')) {
        if (mode === '429 lost') row.packaging_started_at = 'new-owner';
        throw Object.assign(new WorkflowDispatchRateLimitError(429, new Date(Date.now() + 60_000).toISOString()), { dispatchIdentity: mode === '429 no pin' ? undefined : mode === '429 invalid pin' ? 'bad' : 'b'.repeat(64) });
      }
      if (mode === '400') throw new Error('Definite GitHub 400 rejection');
      return undefined as never;
    });
    const response = await POST(new NextRequest('https://example.test/api/updates/trigger', {
      method: 'POST', headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({ updates: [{ winget_id: 'Microsoft.Edge', tenant_id: 'tenant-1' }] }),
    }));
    const body = await response.json();
    expect(triggerPackagingWorkflowMock).toHaveBeenCalledTimes(1);
    expect(posts).toBe(['lost', 'claim error', 'gate stale'].includes(mode) ? 0 : 1);
    if (mode === 'queued') { expect(writes).toHaveLength(0); return; }
    if (mode === 'claim error') { expect(writes).toHaveLength(0); expect(body.triggered).toBe(0); return; }
    expect(writes[0].filters).toMatchObject({ id: 'job-race', user_id: 'user-1', tenant_id: 'tenant-1',
      auto_update_policy_id: 'policy-1', is_auto_update: true, status: 'awaiting_qa',
      qa_resume_due_at: '2026-01-01T00:00:00Z', qa_candidate_id: 'candidate',
      installer_sha256: 'a'.repeat(64), architecture: 'x64', github_run_id: null, callback_run_id: null,
      cancelled_at: null, archived_at: null, error_details: null });
    if (mode === 'lost' || mode === 'gate stale') { expect(writes).toHaveLength(1); expect(writes[0].won).toBe(false); expect(body.triggered).toBe(0); return; }
    if (['503', 'custom 503', '429', '429 no pin', '429 invalid pin', 'custom 429', '429 lost', '400'].includes(mode)) {
      expect(writes).toHaveLength(2);
      expect(writes[1].filters).toMatchObject({ status: 'packaging', packaging_started_at: writes[0].patch.packaging_started_at });
      if (mode === '429 lost') { expect(writes[1].won).toBe(false); expect(body.results[0].error).toMatch(/status changed/); expect(row.packaging_started_at).toBe('new-owner'); return; }
      expect(writes[1].won).toBe(true);
      const terminal = ['custom 503', '429 no pin', '429 invalid pin', 'custom 429'].includes(mode);
      expect(row.status).toBe(terminal ? 'failed' : 'awaiting_qa');
      if (mode === '503' || mode === '429') { expect(row.error_details).toHaveProperty('workflow_dispatch_unconfirmed_identity', 'b'.repeat(64)); expect(body.triggered).toBe(1); }
      if (terminal) expect(body.failed).toBe(1);
    } else { expect(writes).toHaveLength(1); expect(body.triggered).toBe(1); }
  });

});
