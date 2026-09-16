import { NextRequest } from 'next/server';

const {
  getDatabaseMock,
  listDeployedPairsMock,
  listCachedPairsMock,
  scanTenantForUpdatesMock,
  storeScanForUserMock,
  notifyMock,
} = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
  listDeployedPairsMock: vi.fn(),
  listCachedPairsMock: vi.fn(),
  scanTenantForUpdatesMock: vi.fn(),
  storeScanForUserMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getDatabase: getDatabaseMock }));
vi.mock('@/lib/supabase', () => ({ getServerClientOrNull: () => null }));
vi.mock('@/app/api/intune/apps/updates/route', () => ({
  scanTenantForUpdates: scanTenantForUpdatesMock,
}));
vi.mock('@/lib/updates/store-scan', () => ({ storeScanForUser: storeScanForUserMock }));
vi.mock('@/lib/notifications/notify-user', () => ({
  notifyUserOfPendingUpdates: notifyMock,
}));

import { GET } from '@/app/api/cron/refresh-updates/route';

function cronRequest(secret = 'topsecret') {
  const request = new NextRequest('http://localhost:3000/api/cron/refresh-updates');
  request.headers.set('Authorization', `Bearer ${secret}`);
  return request;
}

describe('GET /api/cron/refresh-updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'topsecret';
    getDatabaseMock.mockReturnValue({
      uploadHistory: { listUserTenants: listDeployedPairsMock },
      updateCheckResults: { listUserTenants: listCachedPairsMock },
    });
    listDeployedPairsMock.mockResolvedValue([]);
    listCachedPairsMock.mockResolvedValue([]);
    scanTenantForUpdatesMock.mockResolvedValue({ updates: [], checked: [], totalApps: 0 });
    storeScanForUserMock.mockResolvedValue({
      refreshedCount: 0,
      removedCount: 0,
      pendingNotifications: 0,
    });
  });

  it('rejects a call without the shared secret', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/refresh-updates');

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(scanTenantForUpdatesMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    const response = await GET(cronRequest('guessed'));

    expect(response.status).toBe(401);
    expect(scanTenantForUpdatesMock).not.toHaveBeenCalled();
  });

  it('refreshes an admin who has rows but never deployed anything', async () => {
    // The point of the second source: an admin who only updates apps a
    // colleague deployed has no deployment history of their own. Scanning only
    // the deployers would leave their rows frozen forever, which is how two
    // admins ended up seeing different versions of the same package.
    listDeployedPairsMock.mockResolvedValue([
      { user_id: 'admin-a', tenant_id: 'tenant-1' },
    ]);
    listCachedPairsMock.mockResolvedValue([
      { user_id: 'admin-b', tenant_id: 'tenant-1' },
    ]);

    const response = await GET(cronRequest());
    const body = await response.json();

    expect(body.scanned).toBe(2);
    expect(scanTenantForUpdatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-b', tenantId: 'tenant-1' })
    );
  });

  it('scans a user present in both sources only once', async () => {
    listDeployedPairsMock.mockResolvedValue([
      { user_id: 'admin-a', tenant_id: 'tenant-1' },
    ]);
    listCachedPairsMock.mockResolvedValue([
      { user_id: 'admin-a', tenant_id: 'tenant-1' },
    ]);

    const body = await (await GET(cronRequest())).json();

    expect(body.scanned).toBe(1);
    expect(scanTenantForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one tenant fails', async () => {
    // A tenant without consent, or one whose service principal cannot get a
    // token, must not cost every other tenant its refresh.
    listDeployedPairsMock.mockResolvedValue([
      { user_id: 'admin-a', tenant_id: 'broken' },
      { user_id: 'admin-b', tenant_id: 'tenant-1' },
    ]);
    scanTenantForUpdatesMock
      .mockRejectedValueOnce(new Error('no consent'))
      .mockResolvedValueOnce({ updates: [], checked: [], totalApps: 0 });

    const body = await (await GET(cronRequest())).json();

    expect(body.success).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.scanned).toBe(2);
    expect(storeScanForUserMock).toHaveBeenCalledTimes(1);
    expect(body.results.find((r: { tenantId: string }) => r.tenantId === 'broken').error)
      .toContain('no consent');
  });

  it('notifies only when the scan produced something new', async () => {
    listDeployedPairsMock.mockResolvedValue([
      { user_id: 'admin-a', tenant_id: 'tenant-1' },
      { user_id: 'admin-b', tenant_id: 'tenant-1' },
    ]);
    storeScanForUserMock
      .mockResolvedValueOnce({ refreshedCount: 3, removedCount: 0, pendingNotifications: 2 })
      .mockResolvedValueOnce({ refreshedCount: 1, removedCount: 0, pendingNotifications: 0 });

    const body = await (await GET(cronRequest())).json();

    expect(body.refreshedRows).toBe(4);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    // No forced send: nobody asked for this run, so the user's configured
    // frequency still applies.
    expect(notifyMock).toHaveBeenCalledWith(null, 'admin-a');
  });
});
