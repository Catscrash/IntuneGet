/**
 * Update Policies API Routes
 * GET - List all policies for the user
 * POST - Create or update a policy
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getCatalogSource } from '@/lib/catalog';
import { parseAccessToken } from '@/lib/auth-utils';
import { buildDeploymentConfigForApp } from '@/lib/update-policies/build-deployment-config';
import type { AppUpdatePolicyInput, AppUpdatePolicy, DeploymentConfig } from '@/types/update-policies';
import type { Json } from '@/types/database';

/**
 * GET /api/update-policies
 * Get all update policies for the user, optionally filtered by tenant
 */
export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const tenantId = searchParams.get('tenant_id');

    // Policies go through the db abstraction, so pin, ignore, notify and
    // auto-update work in Supabase-less SQLite installs too. They used to
    // answer 503 here, which left the Updates page with no way to silence or
    // hold back an app.
    const policies = await getDatabase().updatePolicies.getByUserId(
      user.userId,
      tenantId
    );

    return NextResponse.json({
      policies: policies as unknown as AppUpdatePolicy[],
      count: policies.length,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/update-policies
 * Create or update an update policy
 */
export async function POST(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body: AppUpdatePolicyInput = await request.json();

    // Validate required fields
    if (!body.winget_id || !body.tenant_id || !body.policy_type) {
      return NextResponse.json(
        { error: 'Missing required fields: winget_id, tenant_id, policy_type' },
        { status: 400 }
      );
    }

    // Validate policy type
    const validPolicyTypes = ['auto_update', 'notify', 'ignore', 'pin_version'];
    if (!validPolicyTypes.includes(body.policy_type)) {
      return NextResponse.json(
        { error: `Invalid policy_type. Must be one of: ${validPolicyTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const db = getDatabase();

    // Fields the client may omit for pin_version / auto_update. We derive them
    // server-side below so the bell-icon dropdown can set these policies with
    // just { winget_id, tenant_id, policy_type }.
    let derivedPinnedVersion = body.pinned_version || null;
    let derivedDeploymentConfig: DeploymentConfig | null = body.deployment_config || null;
    let derivedOriginalUploadHistoryId = body.original_upload_history_id || null;

    // Pin version requires a version. If the client didn't send one, derive the
    // currently deployed version for this app.
    if (body.policy_type === 'pin_version' && !derivedPinnedVersion) {
      const detected = await db.updateCheckResults.getByUserId(
        user.userId,
        body.tenant_id
      );
      derivedPinnedVersion =
        detected.find((row) => row.winget_id === body.winget_id)?.current_version || null;

      if (!derivedPinnedVersion) {
        // No detected update for this app - pin to whatever this tenant last
        // deployed. getByUserIdAndTenantId returns newest first.
        const history = await db.uploadHistory.getByUserIdAndTenantId(
          user.userId,
          body.tenant_id
        );
        derivedPinnedVersion =
          history.find((row) => row.winget_id === body.winget_id)?.version || null;
      }

      if (!derivedPinnedVersion) {
        return NextResponse.json(
          { error: 'pinned_version is required for pin_version policy' },
          { status: 400 }
        );
      }
    }

    // Auto-update requires a deployment config. If the client didn't send one,
    // build it from the app's prior deployment or the catalog.
    if (body.policy_type === 'auto_update' && !derivedDeploymentConfig) {
      // Resolve the app's latest version: prefer the update check row, fall
      // back to the catalog's latest_version.
      const detected = await db.updateCheckResults.getByUserId(
        user.userId,
        body.tenant_id
      );
      let latestVersion =
        detected.find((row) => row.winget_id === body.winget_id)?.latest_version || '';
      if (!latestVersion) {
        const catalogApp = await getCatalogSource().getAppForInstaller(body.winget_id);
        latestVersion = catalogApp?.latest_version || '';
      }

      // The builder reads upload_history and packaging_jobs through the db
      // abstraction and resolves its own catalog, so it needs no client.
      const built = await buildDeploymentConfigForApp(null, {
        userId: user.userId,
        tenantId: body.tenant_id,
        wingetId: body.winget_id,
        latestVersion,
      });

      if (built.status !== 'ok') {
        return NextResponse.json(
          {
            error:
              built.status === 'orphaned_job'
                ? 'Could not retrieve the saved deployment configuration for this app.'
                : 'Auto-update requires a prior deployment of this app, or the app must be in the catalog.',
          },
          { status: 400 }
        );
      }

      derivedDeploymentConfig = built.deploymentConfig;
      derivedOriginalUploadHistoryId = built.originalUploadHistoryId;
    }

    // One policy per user, tenant and app: the adapter upserts on that triple
    // so the bell-icon dropdown can set a policy without first looking one up.
    const { policy, created } = await db.updatePolicies.upsert({
      user_id: user.userId,
      tenant_id: body.tenant_id,
      winget_id: body.winget_id,
      policy_type: body.policy_type,
      pinned_version: body.policy_type === 'pin_version' ? derivedPinnedVersion : null,
      deployment_config: (derivedDeploymentConfig || null) as Record<string, unknown> | null,
      original_upload_history_id: derivedOriginalUploadHistoryId,
      is_enabled: body.is_enabled ?? true,
    });

    return NextResponse.json({
      policy: policy as unknown as AppUpdatePolicy,
      created,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
