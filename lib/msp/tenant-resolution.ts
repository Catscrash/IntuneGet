import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import {
  canAccessPrimaryTenant,
  hasPermission,
  parseRole,
  type AccessMode,
  type Permission,
} from '@/lib/msp-permissions';

interface ResolveTargetTenantInput {
  supabase: ReturnType<typeof createServerClient>;
  userId: string;
  tokenTenantId: string;
  requestedTenantId: string | null;
  /**
   * Permission the caller's MSP role has to carry for this operation. Every
   * route that writes to a tenant - queueing a deployment, mutating Intune
   * configuration - passes the permission it needs, so the role matrix is
   * enforced where the tenant is resolved instead of once per route. Users
   * with no MSP membership are unaffected, which keeps single-tenant installs
   * working as before.
   */
  requiredPermission?: Permission;
}

interface ResolveTargetTenantResult {
  tenantId: string;
  errorResponse: NextResponse | null;
}

interface MembershipWithOrg {
  access_mode: AccessMode;
  role: string | null;
  msp_organization_id: string;
  msp_organizations: {
    primary_tenant_id: string;
  };
}

const CUSTOMER_ONLY_ERROR =
  'Your MSP membership is limited to customer tenants. Select a customer tenant to continue.';
const PERMISSION_ERROR = 'Your MSP role does not allow this operation.';

/**
 * Resolve the effective tenant for MSP users and enforce tenant access checks.
 * Falls back to token tenant when no override is requested.
 *
 * For members with access_mode 'customer_only', the MSP organization's primary
 * tenant is rejected regardless of how it was targeted (explicit header or the
 * token tenant fallback), since every member's token tenant is the primary
 * tenant.
 *
 * Callers that write pass requiredPermission, which is checked against the
 * member's role before any tenant is handed back.
 */
export async function resolveTargetTenantId({
  supabase,
  userId,
  tokenTenantId,
  requestedTenantId,
  requiredPermission,
}: ResolveTargetTenantInput): Promise<ResolveTargetTenantResult> {
  const { data: membershipData } = await supabase
    .from('msp_user_memberships')
    .select('access_mode, role, msp_organization_id, msp_organizations!inner(primary_tenant_id)')
    .eq('user_id', userId)
    .single();

  const membership = membershipData as unknown as MembershipWithOrg | null;

  const targetTenantId = requestedTenantId || tokenTenantId;

  // An unreadable role parses as the least privileged one, so a membership row
  // that predates the role column cannot write anywhere
  if (
    membership &&
    requiredPermission &&
    !hasPermission(parseRole(membership.role), requiredPermission)
  ) {
    return {
      tenantId: tokenTenantId,
      errorResponse: NextResponse.json({ error: PERMISSION_ERROR }, { status: 403 }),
    };
  }

  // Members limited to customer tenants can never target the org's primary tenant
  if (
    membership &&
    !canAccessPrimaryTenant(membership.access_mode) &&
    targetTenantId === membership.msp_organizations.primary_tenant_id
  ) {
    return {
      tenantId: tokenTenantId,
      errorResponse: NextResponse.json(
        { error: CUSTOMER_ONLY_ERROR },
        { status: 403 }
      ),
    };
  }

  if (targetTenantId === tokenTenantId) {
    return { tenantId: tokenTenantId, errorResponse: null };
  }

  if (!membership) {
    return {
      tenantId: tokenTenantId,
      errorResponse: NextResponse.json(
        { error: 'Not authorized to access other tenants' },
        { status: 403 }
      ),
    };
  }

  const { data: managedTenant } = await supabase
    .from('msp_managed_tenants')
    .select('id')
    .eq('msp_organization_id', membership.msp_organization_id)
    .eq('tenant_id', targetTenantId)
    .eq('consent_status', 'granted')
    .eq('is_active', true)
    .single();

  if (!managedTenant) {
    return {
      tenantId: tokenTenantId,
      errorResponse: NextResponse.json(
        { error: 'Target tenant is not managed by your MSP organization or has not granted consent' },
        { status: 403 }
      ),
    };
  }

  return { tenantId: targetTenantId, errorResponse: null };
}
