import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getDatabaseMock, getByTenantIdMock, getJobByIdMock, getCatalogSourceMock } = vi.hoisted(
  () => ({
    getDatabaseMock: vi.fn(),
    getByTenantIdMock: vi.fn(),
    getJobByIdMock: vi.fn(),
    getCatalogSourceMock: vi.fn(),
  })
);

vi.mock('@/lib/db', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('@/lib/catalog', () => ({
  getCatalogSource: getCatalogSourceMock,
}));

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}));

import { buildDeploymentConfigForApp } from '@/lib/update-policies/build-deployment-config';

const REQUIREMENT_RULE = {
  '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRequirement',
  displayName: 'Only on workstations',
  operator: 'equal',
  detectionType: 'string',
  expectedValue: 'ok',
  scriptContent: 'Write-Output "ok"',
};

describe('buildDeploymentConfigForApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDatabaseMock.mockReturnValue({
      uploadHistory: { getByTenantId: getByTenantIdMock },
      jobs: { getById: getJobByIdMock },
    });
    getCatalogSourceMock.mockReturnValue({
      getAppByWingetId: vi.fn(async () => null),
      appExists: vi.fn(async () => false),
    });
  });

  it("reuses a colleague's deployment config, keeping assignments and requirement scripts", async () => {
    // Admin A deployed the app; Admin B pushes the update. Scoping the history
    // lookup to the caller sent Admin B down the catalog-default path, which
    // assigns nothing and carries no requirement rules - so the update landed
    // in Intune stripped of both.
    getByTenantIdMock.mockResolvedValue([
      {
        id: 'history-1',
        user_id: 'admin-a',
        winget_id: 'Git.Git',
        packaging_job_id: 'job-1',
        intune_app_id: 'app-git',
      },
    ]);
    getJobByIdMock.mockResolvedValue({
      id: 'job-1',
      display_name: 'Git',
      publisher: 'Git',
      architecture: 'x64',
      installer_type: 'exe',
      install_command: 'setup.exe /S',
      uninstall_command: 'uninstall.exe /S',
      install_scope: 'system',
      detection_rules: [],
      package_config: {
        assignments: [{ type: 'group', groupId: 'group-1', intent: 'required' }],
        requirementRules: [REQUIREMENT_RULE],
      },
    });

    const result = await buildDeploymentConfigForApp(null, {
      tenantId: 'tenant-1',
      wingetId: 'Git.Git',
      latestVersion: '2.45.0',
    });

    expect(getByTenantIdMock).toHaveBeenCalledWith('tenant-1');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.originalUploadHistoryId).toBe('history-1');
    expect(result.deploymentConfig.assignments).toEqual([
      { type: 'group', groupId: 'group-1', intent: 'required' },
    ]);
    expect(result.deploymentConfig.requirementRules).toEqual([REQUIREMENT_RULE]);
  });

  it('reports an orphaned job rather than silently falling back to defaults', async () => {
    getByTenantIdMock.mockResolvedValue([
      { id: 'history-1', user_id: 'admin-a', winget_id: 'Git.Git', packaging_job_id: 'job-gone' },
    ]);
    getJobByIdMock.mockResolvedValue(null);

    const result = await buildDeploymentConfigForApp(null, {
      tenantId: 'tenant-1',
      wingetId: 'Git.Git',
      latestVersion: '2.45.0',
    });

    expect(result.status).toBe('orphaned_job');
  });
});
