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
import { SHARED_SETTINGS_ROW_ID } from '@/lib/user-settings-store';

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
      SHARED_SETTINGS_ROW_ID,
      expect.objectContaining({ virusTotalMaliciousThreshold: 4 })
    );
  });

  it('stores a threshold of zero, which turns the check off', async () => {
    await PATCH(patch({ virusTotalMaliciousThreshold: 0 }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      SHARED_SETTINGS_ROW_ID,
      expect.objectContaining({ virusTotalMaliciousThreshold: 0 })
    );
  });

  it('normalises an unusable threshold to the default rather than to "off"', async () => {
    await PATCH(patch({ virusTotalMaliciousThreshold: 'nonsense' }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      SHARED_SETTINGS_ROW_ID,
      expect.objectContaining({ virusTotalMaliciousThreshold: 1 })
    );
  });

  it('stores the description signature', async () => {
    // Same allow-list trap as the threshold: a key missing from sanitizeSettings
    // is dropped on save and on load, so the field would look saved and never
    // reach a deployment.
    await PATCH(patch({ appDescriptionSuffix: 'Packaged with care by IT' }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      SHARED_SETTINGS_ROW_ID,
      expect.objectContaining({ appDescriptionSuffix: 'Packaged with care by IT' })
    );
  });

  it('strips control characters from the signature instead of failing', async () => {
    // It ends up in a Graph payload; a stray character must not fail a deploy.
    await PATCH(patch({ appDescriptionSuffix: 'by\u0000 IT\u0007' }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      SHARED_SETTINGS_ROW_ID,
      expect.objectContaining({ appDescriptionSuffix: 'by IT' })
    );
  });

  it('reads the stored signature back out', async () => {
    getSettingsMock.mockResolvedValue({ appDescriptionSuffix: 'by IT' });

    const body = await (await GET(get())).json();

    expect(body.settings.appDescriptionSuffix).toBe('by IT');
  });

  it('reads the stored threshold back out', async () => {
    getSettingsMock.mockResolvedValue({ virusTotalMaliciousThreshold: 4 });

    const body = await (await GET(get())).json();

    expect(body.settings.virusTotalMaliciousThreshold).toBe(4);
  });

  it('still keeps the existing boolean settings', async () => {
    await PATCH(patch({ allowAvailableUninstall: true, carryOverAssignments: true }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      SHARED_SETTINGS_ROW_ID,
      expect.objectContaining({ allowAvailableUninstall: true, carryOverAssignments: true })
    );
  });

  it('rejects a payload with nothing recognisable in it', async () => {
    const response = await PATCH(patch({ somethingElse: true }));

    expect(response.status).toBe(400);
    expect(mergeSettingsMock).not.toHaveBeenCalled();
  });
});

describe('shared vs personal settings', () => {
  it('keeps cart behaviour on the signed-in user', async () => {
    await PATCH(patch({ cartAutoOpenOnAdd: true }));

    expect(mergeSettingsMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ cartAutoOpenOnAdd: true })
    );
    expect(mergeSettingsMock).not.toHaveBeenCalledWith(
      SHARED_SETTINGS_ROW_ID,
      expect.anything()
    );
  });

  it('writes a mixed payload to both rows, each key only once', async () => {
    await PATCH(patch({ theme: 'dark', supersedePreviousApp: true }));

    expect(mergeSettingsMock).toHaveBeenCalledWith('user-1', { theme: 'dark' });
    expect(mergeSettingsMock).toHaveBeenCalledWith(SHARED_SETTINGS_ROW_ID, {
      supersedePreviousApp: true,
    });
  });

  it('touches no personal row when only shared settings change', async () => {
    await PATCH(patch({ carryOverAssignments: true }));

    expect(mergeSettingsMock).not.toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('answers with the shared value it just wrote', async () => {
    // The shared value lives in another row, so echoing the personal row back
    // would show the page the old value until the next reload.
    getSettingsMock.mockResolvedValue({ theme: 'dark' });
    mergeSettingsMock.mockResolvedValue({ theme: 'dark' });

    const body = await (await PATCH(patch({ appDescriptionSuffix: 'by IT' }))).json();

    expect(body.settings.appDescriptionSuffix).toBe('by IT');
  });

  it('serves one admin the value another admin set', async () => {
    getSettingsMock.mockImplementation(async (id: string) =>
      id === SHARED_SETTINGS_ROW_ID
        ? { appDescriptionSuffix: 'by IT', virusTotalMaliciousThreshold: 4 }
        : { appDescriptionSuffix: 'by Alice', theme: 'dark' }
    );

    const body = await (await GET(get())).json();

    expect(body.settings.appDescriptionSuffix).toBe('by IT');
    expect(body.settings.virusTotalMaliciousThreshold).toBe(4);
    expect(body.settings.theme).toBe('dark');
  });

  it('still shows a value set before the key became shared', async () => {
    getSettingsMock.mockImplementation(async (id: string) =>
      id === SHARED_SETTINGS_ROW_ID ? null : { carryOverAssignments: true }
    );

    const body = await (await GET(get())).json();

    expect(body.settings.carryOverAssignments).toBe(true);
  });
});
