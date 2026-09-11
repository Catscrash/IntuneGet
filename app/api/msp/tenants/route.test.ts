/**
 * Tenant management is reserved for roles carrying `manage_tenants`, and the
 * server-side Supabase client bypasses RLS - so these handlers are the only
 * thing standing between a viewer and someone else's customer tenants.
 */
import { NextRequest } from 'next/server';

const {
  parseAccessTokenMock,
  createServerClientMock,
  getMspCustomerConsentUrlMock,
  signConsentStateMock,
  getBaseUrlMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  createServerClientMock: vi.fn(),
  getMspCustomerConsentUrlMock: vi.fn(),
  signConsentStateMock: vi.fn(),
  getBaseUrlMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: parseAccessTokenMock,
  signConsentState: signConsentStateMock,
  getBaseUrl: getBaseUrlMock,
}));

vi.mock('@/lib/msal-config', () => ({
  getMspCustomerConsentUrl: getMspCustomerConsentUrlMock,
}));

vi.mock('@/lib/supabase', () => ({
  createServerClient: createServerClientMock,
}));

import {
  DELETE as deleteTenant,
  POST as addTenant,
} from '@/app/api/msp/tenants/route';
import { POST as regenerateConsentUrl } from '@/app/api/msp/tenants/[id]/consent-url/route';

interface SupabaseCall {
  table: string;
  operation: string;
  value?: unknown;
}

const calls: SupabaseCall[] = [];
const membershipSelects: string[] = [];
let currentRole = 'viewer';

function createQuery(table: string) {
  let operation = 'select';
  const query = {
    select(value: string) {
      calls.push({ table, operation: 'select', value });
      if (table === 'msp_user_memberships') {
        membershipSelects.push(value);
      }
      return query;
    },
    eq(column: string, value: unknown) {
      calls.push({ table, operation: 'eq', value: { column, value } });
      if (operation === 'update' && table === 'msp_managed_tenants') {
        return Promise.resolve({ error: null });
      }
      return query;
    },
    insert(value: unknown) {
      operation = 'insert';
      calls.push({ table, operation: 'insert', value });
      return query;
    },
    update(value: unknown) {
      operation = 'update';
      calls.push({ table, operation: 'update', value });
      return query;
    },
    single() {
      calls.push({ table, operation: 'single' });
      if (table === 'msp_user_memberships') {
        return Promise.resolve({
          data: {
            msp_organization_id: 'msp-org-1',
            access_mode: 'full',
            role: currentRole,
            msp_organizations: {
              is_active: true,
              primary_tenant_id: 'primary-tenant',
            },
          },
          error: null,
        });
      }
      if (table === 'msp_managed_tenants' && operation === 'insert') {
        return Promise.resolve({
          data: {
            id: 'tenant-record-new',
            msp_organization_id: 'msp-org-1',
            display_name: 'Customer Tenant',
            consent_status: 'pending',
            is_active: true,
          },
          error: null,
        });
      }
      if (table === 'msp_managed_tenants') {
        return Promise.resolve({
          data: {
            id: 'tenant-record-1',
            msp_organization_id: 'msp-org-1',
            tenant_id: 'customer-tenant',
            display_name: 'Existing Customer',
            consent_status: 'pending',
            is_active: true,
          },
          error: null,
        });
      }
      if (table === 'msp_organizations') {
        return Promise.resolve({
          data: { primary_tenant_id: 'primary-tenant' },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  membershipSelects.length = 0;
  currentRole = 'viewer';
  parseAccessTokenMock.mockResolvedValue({
    userId: 'viewer-user',
    userEmail: 'viewer@example.test',
    tenantId: 'primary-tenant',
    userName: 'Viewer',
  });
  createServerClientMock.mockReturnValue({
    from: vi.fn((table: string) => createQuery(table)),
  });
  getBaseUrlMock.mockReturnValue('https://app.example.test');
  signConsentStateMock.mockReturnValue('signed-state');
  getMspCustomerConsentUrlMock.mockReturnValue('https://login.example.test/consent');
});

describe('MSP tenant management role permissions', () => {
  it('blocks a viewer membership from adding a pending customer tenant', async () => {
    const request = new NextRequest('http://localhost/api/msp/tenants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer viewer-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ display_name: 'Customer Tenant' }),
    });

    const response = await addTenant(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('permission');
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        table: 'msp_managed_tenants',
        operation: 'insert',
      })
    );
    expect(membershipSelects[0]).toContain('role');
  });

  it('blocks a viewer membership from regenerating a consent URL', async () => {
    const request = new NextRequest('http://localhost/api/msp/tenants/tenant-record-1/consent-url', {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer-token' },
    });

    const response = await regenerateConsentUrl(request, {
      params: Promise.resolve({ id: 'tenant-record-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('permission');
    expect(getMspCustomerConsentUrlMock).not.toHaveBeenCalled();
    expect(membershipSelects[0]).toContain('role');
  });

  it('blocks a viewer membership from soft-deleting an existing managed tenant', async () => {
    const request = new NextRequest('http://localhost/api/msp/tenants?id=tenant-record-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer viewer-token' },
    });

    const response = await deleteTenant(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('permission');
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        table: 'msp_managed_tenants',
        operation: 'update',
        value: expect.objectContaining({ is_active: false }),
      })
    );
    expect(membershipSelects[0]).toContain('role');
  });

  it('blocks an operator membership from adding a pending customer tenant', async () => {
    currentRole = 'operator';
    const request = new NextRequest('http://localhost/api/msp/tenants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer operator-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ display_name: 'Customer Tenant' }),
    });

    const response = await addTenant(request);

    expect(response.status).toBe(403);
    expect(calls).not.toContainEqual(
      expect.objectContaining({ table: 'msp_managed_tenants', operation: 'insert' })
    );
  });

  it('still allows an admin membership to add a pending customer tenant', async () => {
    currentRole = 'admin';
    const request = new NextRequest('http://localhost/api/msp/tenants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ display_name: 'Customer Tenant' }),
    });

    const response = await addTenant(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.tenant.id).toBe('tenant-record-new');
    expect(body.consentUrl).toBe('https://login.example.test/consent');
  });
});