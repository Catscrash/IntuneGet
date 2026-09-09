import { NextRequest } from 'next/server';

const { parseAccessTokenMock, getSettingsMock, mergeSettingsMock } = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  getSettingsMock: vi.fn(),
  mergeSettingsMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: parseAccessTokenMock }));
vi.mock('@/lib/db', () => ({
  getDatabase: () => ({
    userSettings: { get: getSettingsMock, merge: mergeSettingsMock },
  }),
}));

import { GET, PATCH } from '@/app/api/user/settings/route';

function patch(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/user/settings', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get() {
  const request = new NextRequest('http://localhost:3000/api/user/settings');
  request.headers.set('Authorization', 'Bearer test-token');
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  parseAccessTokenMock.mockResolvedValue({
    userId: 'user-1',
    userEmail: 'user@example.com',
    tenantId: 'tenant-1',
    userName: 'User',
  });
  getSettingsMock.mockResolvedValue(null);
  mergeSettingsMock.mockImplementation(async (_userId: string, partial: Record<string, unknown>) => partial);
});

describe('user settings sanitizer', () => {
  it('stores the antivirus threshold', async () => {
    // The sanitizer is an allow-list, and it runs on save and on load: a key
    // missing from it is dropped both ways, so the setting looks saved in the
    // UI while the gate never sees it.
    const response = await PATCH(patch({ virusTotalMaliciousThreshold: 4 }));

    expect(response.status).toBe(200);
    expect(mergeSettingsMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ virusTotalMaliciousThreshold: 4 })
    );
  });

  it('stores a threshold of zero, which turns the check off', async () => {
    await PATCH(patch({ virusTotalMaliciousThreshold: 0 }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ virusTotalMaliciousThreshold: 0 })
    );
  });

  it('normalises an unusable threshold to the default rather than to "off"', async () => {
    await PATCH(patch({ virusTotalMaliciousThreshold: 'nonsense' }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ virusTotalMaliciousThreshold: 1 })
    );
  });

  it('reads the stored threshold back out', async () => {
    getSettingsMock.mockResolvedValue({ virusTotalMaliciousThreshold: 4 });

    const body = await (await GET(get())).json();

    expect(body.settings.virusTotalMaliciousThreshold).toBe(4);
  });

  it('still keeps the existing boolean settings', async () => {
    await PATCH(patch({ allowAvailableUninstall: true, carryOverAssignments: true }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ allowAvailableUninstall: true, carryOverAssignments: true })
    );
  });

  it('rejects a payload with nothing recognisable in it', async () => {
    const response = await PATCH(patch({ somethingElse: true }));

    expect(response.status).toBe(400);
    expect(mergeSettingsMock).not.toHaveBeenCalled();
  });
});
