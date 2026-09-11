/**
 * The Intune write routes act with the application's own Graph permissions, so
 * the MSP role matrix is the only thing deciding whether the signed-in member
 * may change a tenant's configuration. Each of them has to ask the tenant
 * resolver for the permission it needs and stop when the resolver says no.
 */

import { NextRequest, NextResponse } from 'next/server';

const {
  parseAccessTokenMock,
  resolveTargetTenantIdMock,
  createServerClientMock,
  getServerClientOrNullMock,
  isSupabaseServerConfiguredMock,
  acquireGraphTokenMock,
  addAppToEspProfileMock,
  getServicePrincipalTokenMock,
  getAppMock,
  assignToGroupsMock,
  syncAppCategoriesMock,
  setAppRulesMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  resolveTargetTenantIdMock: vi.fn(),
  createServerClientMock: vi.fn(),
  getServerClientOrNullMock: vi.fn(),
  isSupabaseServerConfiguredMock: vi.fn(),
  acquireGraphTokenMock: vi.fn(),
  addAppToEspProfileMock: vi.fn(),
  getServicePrincipalTokenMock: vi.fn(),
  getAppMock: vi.fn(),
  assignToGroupsMock: vi.fn(),
  syncAppCategoriesMock: vi.fn(),
  setAppRulesMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: parseAccessTokenMock }));
vi.mock('@/lib/msp/tenant-resolution', () => ({
  resolveTargetTenantId: resolveTargetTenantIdMock,
}));
vi.mock('@/lib/supabase', () => ({
  createServerClient: createServerClientMock,
  getServerClientOrNull: getServerClientOrNullMock,
  isSupabaseServerConfigured: isSupabaseServerConfiguredMock,
}));
vi.mock('@/lib/graph-token', () => ({ acquireGraphToken: acquireGraphTokenMock }));
vi.mock('@/lib/esp-api', () => ({ addAppToEspProfile: addAppToEspProfileMock }));
vi.mock('@/lib/intune/graph-client', () => ({
  getServicePrincipalToken: getServicePrincipalTokenMock,
}));
vi.mock('@/lib/intune-api', () => ({
  getApp: getAppMock,
  assignToGroups: assignToGroupsMock,
  convertToGraphAssignments: vi.fn(() => []),
  syncAppCategories: syncAppCategoriesMock,
  setAppRules: setAppRulesMock,
}));

import { POST as addAppToEsp } from '@/app/api/intune/esp-profiles/add-app/route';
import { PATCH as updateAppSettings } from '@/app/api/intune/apps/[id]/settings/route';

const FORBIDDEN = {
  tenantId: 'primary-tenant',
  errorResponse: NextResponse.json(
    { error: 'Your MSP role does not allow this operation.' },
    { status: 403 }
  ),
};

beforeEach(() => {
  vi.clearAllMocks();
  parseAccessTokenMock.mockResolvedValue({
    userId: 'viewer-user',
    userEmail: 'viewer@example.test',
    tenantId: 'primary-tenant',
    userName: 'Viewer',
  });
  isSupabaseServerConfiguredMock.mockReturnValue(true);
  createServerClientMock.mockReturnValue({});
  getServerClientOrNullMock.mockReturnValue({});
});

describe('POST /api/intune/esp-profiles/add-app', () => {
  it('requires deploy_apps and never reaches the ESP profile', async () => {
    resolveTargetTenantIdMock.mockResolvedValue(FORBIDDEN);

    const request = new NextRequest('http://localhost/api/intune/esp-profiles/add-app', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer viewer-token',
        'Content-Type': 'application/json',
        'X-MSP-Tenant-Id': 'customer-tenant',
      },
      body: JSON.stringify({ intuneAppId: 'app-1', espProfileIds: ['esp-1'] }),
    });

    const response = await addAppToEsp(request);

    expect(response.status).toBe(403);
    expect(resolveTargetTenantIdMock.mock.calls[0][0]).toMatchObject({
      requestedTenantId: 'customer-tenant',
      requiredPermission: 'deploy_apps',
    });
    expect(acquireGraphTokenMock).not.toHaveBeenCalled();
    expect(addAppToEspProfileMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/intune/apps/[id]/settings', () => {
  it('requires deploy_apps and never reaches the Intune app', async () => {
    resolveTargetTenantIdMock.mockResolvedValue(FORBIDDEN);

    const request = new NextRequest('http://localhost/api/intune/apps/app-1/settings', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer viewer-token',
        'Content-Type': 'application/json',
        'X-MSP-Tenant-Id': 'customer-tenant',
      },
      body: JSON.stringify({
        categories: [{ id: 'category-1', displayName: 'Finance' }],
      }),
    });

    const response = await updateAppSettings(request, {
      params: Promise.resolve({ id: 'app-1' }),
    });

    expect(response.status).toBe(403);
    expect(resolveTargetTenantIdMock.mock.calls[0][0]).toMatchObject({
      requestedTenantId: 'customer-tenant',
      requiredPermission: 'deploy_apps',
    });
    expect(getServicePrincipalTokenMock).not.toHaveBeenCalled();
    expect(syncAppCategoriesMock).not.toHaveBeenCalled();
    expect(assignToGroupsMock).not.toHaveBeenCalled();
  });
});
