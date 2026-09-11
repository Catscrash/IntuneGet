import { describe, it, expect } from 'vitest';
import { resolveTargetTenantId } from './tenant-resolution';

/**
 * Builds a minimal chainable Supabase stub for resolveTargetTenantId. It only
 * needs to answer two query chains, both ending in .single():
 *   from('msp_user_memberships').select(...).eq(...).single()  -> membership
 *   from('msp_managed_tenants').select(...).eq(...)...single()  -> managedTenant
 */
function makeSupabase(opts: {
  membership: unknown;
  managedTenant?: unknown;
}) {
  const results: Record<string, unknown> = {
    msp_user_memberships: opts.membership,
    msp_managed_tenants: opts.managedTenant ?? null,
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.single = async () => ({ data: results[table] ?? null, error: null });
      return builder;
    },
  } as unknown as Parameters<typeof resolveTargetTenantId>[0]['supabase'];
}

const PRIMARY = 'primary-tenant-id';
const CUSTOMER = 'customer-tenant-id';

const fullMembership = {
  access_mode: 'full',
  role: 'admin',
  msp_organization_id: 'org-1',
  msp_organizations: { primary_tenant_id: PRIMARY },
};
const customerOnlyMembership = {
  access_mode: 'customer_only',
  role: 'admin',
  msp_organization_id: 'org-1',
  msp_organizations: { primary_tenant_id: PRIMARY },
};
const viewerMembership = {
  access_mode: 'full',
  role: 'viewer',
  msp_organization_id: 'org-1',
  msp_organizations: { primary_tenant_id: PRIMARY },
};

describe('resolveTargetTenantId', () => {
  it('allows a full-access member to target the primary tenant via header', async () => {
    const supabase = makeSupabase({
      membership: fullMembership,
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: PRIMARY,
    });
    expect(result.errorResponse).toBeNull();
    expect(result.tenantId).toBe(PRIMARY);
  });

  it('allows a full-access member to target a granted customer tenant', async () => {
    const supabase = makeSupabase({
      membership: fullMembership,
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: CUSTOMER,
    });
    expect(result.errorResponse).toBeNull();
    expect(result.tenantId).toBe(CUSTOMER);
  });

  it('rejects a customer-only member targeting the primary tenant via header', async () => {
    const supabase = makeSupabase({
      membership: customerOnlyMembership,
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: PRIMARY,
    });
    expect(result.errorResponse).not.toBeNull();
    expect(result.errorResponse?.status).toBe(403);
  });

  it('rejects a customer-only member with no header (token tenant is the primary tenant)', async () => {
    const supabase = makeSupabase({ membership: customerOnlyMembership });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: null,
    });
    expect(result.errorResponse).not.toBeNull();
    expect(result.errorResponse?.status).toBe(403);
  });

  it('allows a customer-only member to target a granted customer tenant', async () => {
    const supabase = makeSupabase({
      membership: customerOnlyMembership,
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: CUSTOMER,
    });
    expect(result.errorResponse).toBeNull();
    expect(result.tenantId).toBe(CUSTOMER);
  });

  it('rejects a customer-only member targeting an unmanaged tenant', async () => {
    const supabase = makeSupabase({
      membership: customerOnlyMembership,
      managedTenant: null,
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: 'some-other-tenant',
    });
    expect(result.errorResponse).not.toBeNull();
    expect(result.errorResponse?.status).toBe(403);
  });

  it('returns the token tenant unchanged for a non-MSP user with no header', async () => {
    const supabase = makeSupabase({ membership: null });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: 'solo-tenant',
      requestedTenantId: null,
    });
    expect(result.errorResponse).toBeNull();
    expect(result.tenantId).toBe('solo-tenant');
  });

  it('rejects a viewer membership when the caller requires deploy_apps', async () => {
    const supabase = makeSupabase({
      membership: viewerMembership,
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: CUSTOMER,
      requiredPermission: 'deploy_apps',
    });
    expect(result.errorResponse?.status).toBe(403);
    expect(result.tenantId).toBe(PRIMARY);
  });

  it('rejects a viewer membership on its own tenant too', async () => {
    const supabase = makeSupabase({ membership: viewerMembership });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: null,
      requiredPermission: 'deploy_apps',
    });
    expect(result.errorResponse?.status).toBe(403);
  });

  it('rejects a membership row with no readable role', async () => {
    const supabase = makeSupabase({
      membership: { ...viewerMembership, role: null },
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: CUSTOMER,
      requiredPermission: 'deploy_apps',
    });
    expect(result.errorResponse?.status).toBe(403);
  });

  it('allows a viewer membership to read, where no permission is required', async () => {
    const supabase = makeSupabase({
      membership: viewerMembership,
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: CUSTOMER,
    });
    expect(result.errorResponse).toBeNull();
    expect(result.tenantId).toBe(CUSTOMER);
  });

  it('allows an operator membership to deploy into a granted customer tenant', async () => {
    const supabase = makeSupabase({
      membership: { ...viewerMembership, role: 'operator' },
      managedTenant: { id: 'mt-1' },
    });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: PRIMARY,
      requestedTenantId: CUSTOMER,
      requiredPermission: 'deploy_apps',
    });
    expect(result.errorResponse).toBeNull();
    expect(result.tenantId).toBe(CUSTOMER);
  });

  it('leaves a user with no MSP membership alone when a permission is required', async () => {
    const supabase = makeSupabase({ membership: null });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: 'solo-tenant',
      requestedTenantId: null,
      requiredPermission: 'deploy_apps',
    });
    expect(result.errorResponse).toBeNull();
    expect(result.tenantId).toBe('solo-tenant');
  });

  it('rejects a non-MSP user trying to target a different tenant', async () => {
    const supabase = makeSupabase({ membership: null });
    const result = await resolveTargetTenantId({
      supabase,
      userId: 'u1',
      tokenTenantId: 'solo-tenant',
      requestedTenantId: 'other-tenant',
    });
    expect(result.errorResponse).not.toBeNull();
    expect(result.errorResponse?.status).toBe(403);
  });
});
