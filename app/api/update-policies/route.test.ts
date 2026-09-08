import { NextRequest } from 'next/server';

const {
  parseAccessTokenMock,
  getDatabaseMock,
  getHistoryMock,
  getJobByIdMock,
  getDetectedUpdatesMock,
  upsertPolicyMock,
  getPoliciesByUserMock,
  getCatalogSourceMock,
  getAppForInstallerMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getHistoryMock: vi.fn(),
  getJobByIdMock: vi.fn(),
  getDetectedUpdatesMock: vi.fn(),
  upsertPolicyMock: vi.fn(),
  getPoliciesByUserMock: vi.fn(),
  getCatalogSourceMock: vi.fn(),
  getAppForInstallerMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/catalog', () => ({
  getCatalogSource: getCatalogSourceMock,
}));

// Everything this route reads and writes - detected updates, upload history,
// packaging jobs and the policies themselves - exists in both backends and is
// reached through the db abstraction, so there is no Supabase client to mock.
vi.mock('@/lib/db', () => ({
  getDatabase: getDatabaseMock,
}));

import { GET, POST } from '@/app/api/update-policies/route';

interface Fixture {
  detected?: Array<Record<string, unknown>>;
  upload_history?: Record<string, unknown> | null;
  packaging_job?: Record<string, unknown> | null;
}

function seed(fixture: Fixture) {
  getDetectedUpdatesMock.mockResolvedValue(fixture.detected ?? []);
  getHistoryMock.mockResolvedValue(fixture.upload_history ? [fixture.upload_history] : []);
  getJobByIdMock.mockResolvedValue(fixture.packaging_job ?? null);
}

/** The policy the upsert was asked to store. */
function savedPolicy(): Record<string, unknown> {
  expect(upsertPolicyMock).toHaveBeenCalledTimes(1);
  return upsertPolicyMock.mock.calls[0][0];
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/update-policies', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getDatabaseMock.mockReturnValue({
    uploadHistory: { getByUserIdAndTenantId: getHistoryMock },
    jobs: { getById: getJobByIdMock },
    updateCheckResults: { getByUserId: getDetectedUpdatesMock },
    updatePolicies: {
      upsert: upsertPolicyMock,
      getByUserId: getPoliciesByUserMock,
    },
  });
  seed({});
  getPoliciesByUserMock.mockResolvedValue([]);
  upsertPolicyMock.mockImplementation(async (policy: Record<string, unknown>) => ({
    policy: { id: 'policy-new', ...policy },
    created: true,
  }));
  parseAccessTokenMock.mockResolvedValue({
    userId: 'user-1',
    userEmail: 'user@example.com',
    tenantId: 'home-tenant',
    userName: 'User',
  });
  getAppForInstallerMock.mockResolvedValue(null);
  getCatalogSourceMock.mockReturnValue({
    getAppForInstaller: getAppForInstallerMock,
  });
});

describe('GET /api/update-policies', () => {
  it('lists the stored policies without Supabase', async () => {
    // Regression: this answered 503 in a self-hosted install, which left the
    // Updates page with no way to see or set pin and ignore at all.
    getPoliciesByUserMock.mockResolvedValue([
      { id: 'policy-1', winget_id: 'Microsoft.Edge', policy_type: 'ignore' },
    ]);

    const request = new NextRequest('http://localhost:3000/api/update-policies?tenant_id=tenant-1');
    request.headers.set('Authorization', 'Bearer test-token');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.policies[0].policy_type).toBe('ignore');
    expect(getPoliciesByUserMock).toHaveBeenCalledWith('user-1', 'tenant-1');
  });

  it('returns 401 without valid auth', async () => {
    parseAccessTokenMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/update-policies');
    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(getPoliciesByUserMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/update-policies', () => {
  it('derives the current version for pin_version when client omits it', async () => {
    seed({
      detected: [
        { winget_id: 'Microsoft.Edge', current_version: '1.2.3', latest_version: '1.3.0' },
      ],
    });

    const response = await POST(
      makeRequest({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
        policy_type: 'pin_version',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(savedPolicy().pinned_version).toBe('1.2.3');
    expect(savedPolicy().policy_type).toBe('pin_version');
    expect(body.created).toBe(true);
  });

  it('falls back to the last deployed version when nothing was detected', async () => {
    // Pinning an app that has no pending update is the normal case: the
    // operator holds it at what is deployed right now.
    seed({
      detected: [],
      upload_history: { id: 'upload-1', winget_id: 'Microsoft.Edge', version: '1.1.0' },
    });

    const response = await POST(
      makeRequest({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
        policy_type: 'pin_version',
      })
    );

    expect(response.status).toBe(200);
    expect(savedPolicy().pinned_version).toBe('1.1.0');
  });

  it('returns 400 for pin_version when no current version can be derived', async () => {
    seed({ detected: [], upload_history: null });

    const response = await POST(
      makeRequest({
        winget_id: 'Missing.App',
        tenant_id: 'tenant-1',
        policy_type: 'pin_version',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('pinned_version');
    expect(upsertPolicyMock).not.toHaveBeenCalled();
  });

  it('derives a deployment_config from a prior deployment for auto_update', async () => {
    seed({
      detected: [
        { winget_id: 'Microsoft.Edge', current_version: '1.0.0', latest_version: '2.0.0' },
      ],
      upload_history: {
        id: 'upload-1',
        packaging_job_id: 'job-1',
        winget_id: 'Microsoft.Edge',
      },
      packaging_job: {
        id: 'job-1',
        display_name: 'Microsoft Edge',
        publisher: 'Microsoft',
        architecture: 'x64',
        installer_type: 'exe',
        install_command: 'setup.exe /silent',
        uninstall_command: 'setup.exe /uninstall',
        install_scope: 'system',
        detection_rules: [],
        package_config: { assignments: [], categories: [] },
      },
    });

    const response = await POST(
      makeRequest({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
        policy_type: 'auto_update',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(savedPolicy().policy_type).toBe('auto_update');
    expect(savedPolicy().original_upload_history_id).toBe('upload-1');
    const config = savedPolicy().deployment_config as Record<string, unknown>;
    expect(config.displayName).toBe('Microsoft Edge');
    expect(config.forceCreateNewApp).toBe(true);
    expect(body.created).toBe(true);
  });

  it('re-targets the prior deployment detection rules at the new version', async () => {
    // The stored rules name the version the previous deployment installed. If
    // they are carried over unchanged, the new app object detects its
    // predecessor and never reports as installed on any device.
    seed({
      detected: [
        { winget_id: 'Microsoft.Edge', current_version: '1.0.0', latest_version: '2.0.0' },
      ],
      upload_history: {
        id: 'upload-1',
        packaging_job_id: 'job-1',
        winget_id: 'Microsoft.Edge',
      },
      packaging_job: {
        id: 'job-1',
        display_name: 'Microsoft Edge',
        publisher: 'Microsoft',
        architecture: 'x64',
        installer_type: 'exe',
        install_command: 'setup.exe /silent',
        uninstall_command: 'setup.exe /uninstall',
        install_scope: 'system',
        detection_rules: [
          {
            type: 'registry',
            keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\IntuneGet\\Apps\\Microsoft_Edge',
            valueName: 'Version',
            check32BitOn64System: false,
            detectionType: 'version',
            operator: 'equal',
            detectionValue: '1.0.0',
          },
        ],
        package_config: { assignments: [], categories: [] },
      },
    });

    const response = await POST(
      makeRequest({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
        policy_type: 'auto_update',
      })
    );

    expect(response.status).toBe(200);
    const config = savedPolicy().deployment_config as Record<string, unknown>;
    const rules = config.detectionRules as Array<Record<string, unknown>>;
    expect(rules[0].detectionValue).toBe('2.0.0');
  });

  it('returns 400 for auto_update with no prior deployment and not in catalog', async () => {
    seed({
      detected: [
        { winget_id: 'Not.InCatalog', current_version: '1.0.0', latest_version: '2.0.0' },
      ],
      upload_history: null,
    });
    // Catalog returns no app -> buildDefaultDeploymentConfig returns null
    getCatalogSourceMock.mockReturnValue({
      getAppForInstaller: getAppForInstallerMock,
      getAppNamePublisher: vi.fn(async () => null),
      getVersionInstallerInfo: vi.fn(async () => null),
    });

    const response = await POST(
      makeRequest({
        winget_id: 'Not.InCatalog',
        tenant_id: 'tenant-1',
        policy_type: 'auto_update',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Auto-update requires');
    expect(upsertPolicyMock).not.toHaveBeenCalled();
  });

  it('creates an ignore policy with just the policy type', async () => {
    const response = await POST(
      makeRequest({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
        policy_type: 'ignore',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(savedPolicy().policy_type).toBe('ignore');
    expect(savedPolicy().pinned_version).toBeNull();
    expect(savedPolicy().deployment_config).toBeNull();
    expect(body.created).toBe(true);
  });

  it('creates a notify policy with just the policy type', async () => {
    const response = await POST(
      makeRequest({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
        policy_type: 'notify',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(savedPolicy().policy_type).toBe('notify');
    expect(body.created).toBe(true);
  });

  it('reports an existing policy as replaced rather than created', async () => {
    // One policy per user, tenant and app: setting a second one from the
    // dropdown must land on the same row.
    upsertPolicyMock.mockResolvedValue({
      policy: { id: 'policy-1', policy_type: 'ignore' },
      created: false,
    });

    const body = await (
      await POST(
        makeRequest({
          winget_id: 'Microsoft.Edge',
          tenant_id: 'tenant-1',
          policy_type: 'ignore',
        })
      )
    ).json();

    expect(body.created).toBe(false);
    expect(body.policy.id).toBe('policy-1');
  });

  it('rejects an unknown policy type', async () => {
    const response = await POST(
      makeRequest({
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-1',
        policy_type: 'uninstall_everything',
      })
    );

    expect(response.status).toBe(400);
    expect(upsertPolicyMock).not.toHaveBeenCalled();
  });
});
