import { NextRequest } from 'next/server';

const {
  parseAccessTokenMock,
  getDatabaseMock,
  getUpdatesMock,
  getHistoryMock,
  getPoliciesMock,
  getAppsByWingetIdsMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getUpdatesMock: vi.fn(),
  getHistoryMock: vi.fn(),
  getPoliciesMock: vi.fn(),
  getAppsByWingetIdsMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/db', () => ({
  getDatabase: getDatabaseMock,
}));

// The route resolves the newest version from the catalog at read time; without
// this the cases below would reach whatever snapshot happens to sit on disk.
vi.mock('@/lib/catalog', () => ({
  getCatalogSource: () => ({ getAppsByWingetIds: getAppsByWingetIdsMock }),
}));

import { GET } from '@/app/api/updates/available/route';

describe('GET /api/updates/available', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No catalog row by default: the stored latest_version stands, which is
    // what the pre-existing cases below assume.
    getAppsByWingetIdsMock.mockResolvedValue([]);
    getDatabaseMock.mockReturnValue({
      updateCheckResults: { getByUserId: getUpdatesMock },
      uploadHistory: {
        getByUserIdAndTenantId: getHistoryMock,
        // Provenance is a tenant fact, not a per-user one: an app a
        // colleague deployed is still an IntuneGet app.
        getByTenantId: getHistoryMock,
      },
      updatePolicies: { getForWingetIds: getPoliciesMock },
    });
    getUpdatesMock.mockResolvedValue([]);
    getHistoryMock.mockResolvedValue([]);
    getPoliciesMock.mockResolvedValue([]);
  });

  it('applies tenant filter to updates and policy lookup', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'home-tenant',
      userName: 'User',
    });

    getUpdatesMock.mockResolvedValue([
      {
        id: 'upd-1',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'Microsoft.Edge',
        intune_app_id: 'app-1',
        display_name: 'Edge',
        current_version: '1.0.0',
        latest_version: '1.1.0',
        is_critical: true,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
    ]);

    getPoliciesMock.mockResolvedValue([
      {
        id: 'pol-1',
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-a',
        policy_type: 'notify',
        is_enabled: true,
        pinned_version: null,
        last_auto_update_at: null,
        last_auto_update_version: null,
        consecutive_failures: 0,
      },
    ]);

    const request = new NextRequest(
      'http://localhost:3000/api/updates/available?tenant_id=tenant-a'
    );
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.criticalCount).toBe(1);
    expect(body.updates[0].policy?.id).toBe('pol-1');

    // Both narrow by tenant in the query rather than in the route: a policy
    // the user set in another tenant must not silence this tenant's update.
    expect(getUpdatesMock).toHaveBeenCalledWith('user-1', 'tenant-a');
    expect(getPoliciesMock).toHaveBeenCalledWith('user-1', ['Microsoft.Edge'], 'tenant-a');
  });

  it('hides unmanaged updates by default and includes them on request', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'home-tenant',
      userName: 'User',
    });

    const rows = [
      {
        id: 'upd-managed',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'Microsoft.Edge',
        intune_app_id: 'app-1',
        display_name: 'Edge',
        current_version: '1.0.0',
        latest_version: '1.1.0',
        is_critical: false,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
      {
        id: 'upd-unmanaged',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'VideoLAN.VLC',
        intune_app_id: 'app-2',
        display_name: 'VLC',
        current_version: '2.0.0',
        latest_version: '2.1.0',
        is_critical: false,
        is_managed: false,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
    ];

    getUpdatesMock.mockResolvedValue(rows);

    // Default: unmanaged hidden
    const defaultReq = new NextRequest('http://localhost:3000/api/updates/available');
    defaultReq.headers.set('Authorization', 'Bearer test-token');
    const defaultBody = await (await GET(defaultReq)).json();
    expect(defaultBody.count).toBe(1);
    expect(defaultBody.updates[0].winget_id).toBe('Microsoft.Edge');
    expect(defaultBody.updates[0].is_managed).toBe(true);

    // include_unmanaged=true: both managed and unmanaged shown
    const allReq = new NextRequest(
      'http://localhost:3000/api/updates/available?include_unmanaged=true'
    );
    allReq.headers.set('Authorization', 'Bearer test-token');
    const allBody = await (await GET(allReq)).json();
    expect(allBody.count).toBe(2);
  });

  it('serves detected updates and their policies without Supabase', async () => {
    // Regression: this route short-circuited to an empty list without
    // Supabase, so a self-hosted install always rendered "All apps are up to
    // date" - an answer it had never actually checked. Both the updates and
    // the policies annotating them now come from the db abstraction.
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-a',
      userName: 'User',
    });

    getUpdatesMock.mockResolvedValue([
      {
        id: 'upd-1',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'Microsoft.Edge',
        intune_app_id: 'app-1',
        display_name: 'Edge',
        current_version: '1.0.0',
        latest_version: '1.1.0',
        is_critical: true,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
    ]);
    getHistoryMock.mockResolvedValue([
      { winget_id: 'Microsoft.Edge', intune_tenant_id: 'tenant-a' },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.criticalCount).toBe(1);
    expect(body.updates[0].winget_id).toBe('Microsoft.Edge');
    expect(body.updates[0].has_prior_deployment).toBe(true);
    expect(body.updates[0].policy).toBeNull();
  });

  it("counts a colleague's deployment as a prior deployment", async () => {
    // has_prior_deployment drives the "Create New App" confirmation on the
    // updates page. Asked per user, an app another administrator deployed
    // prompted it for everyone else - and confirming there is what sends the
    // update out without the previous version's configuration.
    getUpdatesMock.mockResolvedValue([
      {
        id: 'upd-1',
        user_id: 'admin-b',
        tenant_id: 'tenant-a',
        winget_id: 'Git.Git',
        intune_app_id: 'app-git',
        display_name: 'Git',
        current_version: '2.43.0',
        latest_version: '2.45.0',
        is_critical: false,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
    ]);
    getHistoryMock.mockResolvedValue([
      { winget_id: 'Git.Git', intune_tenant_id: 'tenant-a', user_id: 'admin-a' },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    const response = await GET(request);
    const body = await response.json();

    expect(getHistoryMock).toHaveBeenCalledWith('tenant-a');
    expect(body.updates[0].has_prior_deployment).toBe(true);
  });

  it('reports the ignore and pin policies that let the page hold an app back', async () => {
    // Without these the Updates page cannot tell a held-back app from any
    // other: "Update All" excludes ignore and pin by reading exactly this.
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-a',
      userName: 'User',
    });

    getUpdatesMock.mockResolvedValue([
      {
        id: 'upd-ignored',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'Microsoft.Edge',
        intune_app_id: 'app-1',
        display_name: 'Edge',
        current_version: '1.0.0',
        latest_version: '1.1.0',
        is_critical: false,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
      {
        id: 'upd-pinned',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'VideoLAN.VLC',
        intune_app_id: 'app-2',
        display_name: 'VLC',
        current_version: '2.0.0',
        latest_version: '2.1.0',
        is_critical: false,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
    ]);
    getPoliciesMock.mockResolvedValue([
      {
        id: 'pol-ignore',
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-a',
        policy_type: 'ignore',
        is_enabled: true,
        pinned_version: null,
        last_auto_update_at: null,
        last_auto_update_version: null,
        consecutive_failures: 0,
      },
      {
        id: 'pol-pin',
        winget_id: 'VideoLAN.VLC',
        tenant_id: 'tenant-a',
        policy_type: 'pin_version',
        is_enabled: true,
        pinned_version: '2.0.0',
        last_auto_update_at: null,
        last_auto_update_version: null,
        consecutive_failures: 0,
      },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');
    const body = await (await GET(request)).json();

    const byId = Object.fromEntries(
      body.updates.map((u: { winget_id: string; policy: { policy_type: string } | null }) => [
        u.winget_id,
        u.policy,
      ])
    );
    expect(byId['Microsoft.Edge'].policy_type).toBe('ignore');
    expect(byId['VideoLAN.VLC']).toMatchObject({
      policy_type: 'pin_version',
      pinned_version: '2.0.0',
    });
  });

  it('drops an update the policy already deployed', async () => {
    // last_auto_update_version guards against re-offering a version the
    // policy just rolled out but Intune has not reported back yet.
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-a',
      userName: 'User',
    });

    getUpdatesMock.mockResolvedValue([
      {
        id: 'upd-1',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'Microsoft.Edge',
        intune_app_id: 'app-1',
        display_name: 'Edge',
        current_version: '1.0.0',
        latest_version: '1.1.0',
        is_critical: false,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: null,
      },
    ]);
    getPoliciesMock.mockResolvedValue([
      {
        id: 'pol-1',
        winget_id: 'Microsoft.Edge',
        tenant_id: 'tenant-a',
        policy_type: 'auto_update',
        is_enabled: true,
        pinned_version: null,
        last_auto_update_at: '2026-02-02T00:00:00Z',
        last_auto_update_version: '1.1.0',
        consecutive_failures: 0,
      },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    expect((await (await GET(request)).json()).count).toBe(0);
  });

  function putty(overrides: Record<string, unknown> = {}) {
    return {
      id: 'upd-putty',
      user_id: 'admin-b',
      tenant_id: 'tenant-a',
      winget_id: 'PuTTY.PuTTY',
      intune_app_id: 'app-putty',
      display_name: 'PuTTY',
      current_version: '0.83.0.0',
      latest_version: '0.84.0.0',
      is_critical: false,
      is_managed: true,
      detected_at: '2026-02-01T00:00:00Z',
      notified_at: null,
      dismissed_at: null,
      ...overrides,
    };
  }

  it('serves the catalog version, not the one this user last scanned', async () => {
    // update_check_results is per user, so latest_version froze at whatever the
    // catalog said when that user last refreshed. Two admins who refreshed at
    // different times saw different "latest" versions for the same package for
    // good - nothing rewrites another user's rows.
    parseAccessTokenMock.mockResolvedValue({
      userId: 'admin-b',
      userEmail: 'admin-b@example.com',
      tenantId: 'tenant-a',
      userName: 'Admin B',
    });
    getUpdatesMock.mockResolvedValue([putty()]);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'PuTTY.PuTTY', latest_version: '0.85.0.0' },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    const body = await (await GET(request)).json();

    expect(body.updates[0].latest_version).toBe('0.85.0.0');
  });

  it('resurfaces an update dismissed for an older version', async () => {
    // The refresh path resets dismissed_at when latest_version moves. Resolving
    // the version at read time has to do the same, or a dismissal made for
    // 0.84 would keep hiding 0.85, which the user never saw.
    parseAccessTokenMock.mockResolvedValue({
      userId: 'admin-b',
      userEmail: 'admin-b@example.com',
      tenantId: 'tenant-a',
      userName: 'Admin B',
    });
    getUpdatesMock.mockResolvedValue([
      putty({ dismissed_at: '2026-02-02T00:00:00Z' }),
    ]);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'PuTTY.PuTTY', latest_version: '0.85.0.0' },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    const body = await (await GET(request)).json();

    expect(body.count).toBe(1);
    expect(body.updates[0].latest_version).toBe('0.85.0.0');
  });

  it('keeps a dismissal that still applies to the catalog version', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'admin-b',
      userEmail: 'admin-b@example.com',
      tenantId: 'tenant-a',
      userName: 'Admin B',
    });
    getUpdatesMock.mockResolvedValue([
      putty({ dismissed_at: '2026-02-02T00:00:00Z' }),
    ]);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'PuTTY.PuTTY', latest_version: '0.84.0.0' },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    expect((await (await GET(request)).json()).count).toBe(0);
  });

  it('re-derives critical from the resolved version', async () => {
    // is_critical was stored against the older pair; a major-version jump that
    // only the catalog knows about has to be recognised here.
    parseAccessTokenMock.mockResolvedValue({
      userId: 'admin-b',
      userEmail: 'admin-b@example.com',
      tenantId: 'tenant-a',
      userName: 'Admin B',
    });
    getUpdatesMock.mockResolvedValue([putty()]);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'PuTTY.PuTTY', latest_version: '1.0.0.0' },
    ]);

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    const body = await (await GET(request)).json();

    expect(body.updates[0].is_critical).toBe(true);
    expect(body.criticalCount).toBe(1);
  });

  it('falls back to the stored version when the catalog cannot be read', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'admin-b',
      userEmail: 'admin-b@example.com',
      tenantId: 'tenant-a',
      userName: 'Admin B',
    });
    getUpdatesMock.mockResolvedValue([putty()]);
    getAppsByWingetIdsMock.mockRejectedValue(new Error('catalog unavailable'));

    const request = new NextRequest('http://localhost:3000/api/updates/available');
    request.headers.set('Authorization', 'Bearer test-token');

    const body = await (await GET(request)).json();

    expect(body.updates[0].latest_version).toBe('0.84.0.0');
  });

  it('hides dismissed updates unless asked for them', async () => {
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      userEmail: 'user@example.com',
      tenantId: 'tenant-a',
      userName: 'User',
    });

    getUpdatesMock.mockResolvedValue([
      {
        id: 'upd-dismissed',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
        winget_id: 'Microsoft.Edge',
        intune_app_id: 'app-1',
        display_name: 'Edge',
        current_version: '1.0.0',
        latest_version: '1.1.0',
        is_critical: false,
        is_managed: true,
        detected_at: '2026-02-01T00:00:00Z',
        notified_at: null,
        dismissed_at: '2026-02-02T00:00:00Z',
      },
    ]);

    const hiddenReq = new NextRequest('http://localhost:3000/api/updates/available');
    hiddenReq.headers.set('Authorization', 'Bearer test-token');
    expect((await (await GET(hiddenReq)).json()).count).toBe(0);

    const shownReq = new NextRequest(
      'http://localhost:3000/api/updates/available?include_dismissed=true'
    );
    shownReq.headers.set('Authorization', 'Bearer test-token');
    expect((await (await GET(shownReq)).json()).count).toBe(1);
  });
});
