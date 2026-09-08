import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const {
  parseAccessTokenMock,
  createServerClientMock,
  isSupabaseServerConfiguredMock,
  resolveTargetTenantIdMock,
  acquireGraphTokenMock,
  listEspProfilesMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  createServerClientMock: vi.fn(),
  isSupabaseServerConfiguredMock: vi.fn(),
  resolveTargetTenantIdMock: vi.fn(),
  acquireGraphTokenMock: vi.fn(),
  listEspProfilesMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
}));

vi.mock('@/lib/supabase', () => ({
  createServerClient: createServerClientMock,
  isSupabaseServerConfigured: isSupabaseServerConfiguredMock,
}));

vi.mock('@/lib/msp/tenant-resolution', () => ({
  resolveTargetTenantId: resolveTargetTenantIdMock,
}));

vi.mock('@/lib/graph-token', () => ({
  acquireGraphToken: acquireGraphTokenMock,
}));

vi.mock('@/lib/esp-api', () => ({
  listEspProfiles: listEspProfilesMock,
}));

import { GET } from '@/app/api/intune/esp-profiles/route';

describe('GET /api/intune/esp-profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      userEmail: 'user@example.com',
    });
    resolveTargetTenantIdMock.mockResolvedValue({ tenantId: 'tenant-1', errorResponse: null });
    acquireGraphTokenMock.mockResolvedValue({ accessToken: 'graph-token' });
    listEspProfilesMock.mockResolvedValue([]);
  });

  it('lists profiles from Graph when Supabase server access is not configured', async () => {
    // ESP profiles come from Graph, not Supabase, so a self-hosted install
    // gets the real list rather than an empty one: without Supabase there is
    // no MSP membership to resolve and no consent row to read, so the token's
    // own tenant is the target and the Graph token proves consent.
    isSupabaseServerConfiguredMock.mockReturnValue(false);
    listEspProfilesMock.mockResolvedValue([{ id: 'esp-1', displayName: 'Default ESP' }]);

    const response = await GET(new NextRequest('http://localhost/api/intune/esp-profiles'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profiles: [{ id: 'esp-1', displayName: 'Default ESP' }],
      count: 1,
    });
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(acquireGraphTokenMock).toHaveBeenCalledWith('tenant-1');
  });

  it('resolves the tenant and checks consent when Supabase is configured', async () => {
    isSupabaseServerConfiguredMock.mockReturnValue(true);
    const single = vi.fn().mockResolvedValue({ data: { is_active: true }, error: null });
    const eq2 = vi.fn().mockReturnValue({ single });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    createServerClientMock.mockReturnValue({ from: vi.fn().mockReturnValue({ select }) });

    const response = await GET(new NextRequest('http://localhost/api/intune/esp-profiles'));

    expect(response.status).toBe(200);
    expect(acquireGraphTokenMock).toHaveBeenCalledWith('tenant-1');
  });
});
