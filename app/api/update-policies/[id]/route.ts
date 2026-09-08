/**
 * Update Policy by ID API Routes
 * GET - Get a specific policy
 * PATCH - Update a specific policy
 * DELETE - Delete a specific policy
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { parseAccessToken } from '@/lib/auth-utils';
import type { AppUpdatePolicy, UpdatePolicyType } from '@/types/update-policies';
import type { DatabaseAdapter } from '@/lib/db/types';

type UpdatePolicyPatch = Parameters<DatabaseAdapter['updatePolicies']['update']>[2];

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/update-policies/[id]
 * Get a specific update policy
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Scoped to the owning user in the query: the id is the only thing the
    // client sends, so one tenant admin must not be able to read another's
    // policy by guessing it.
    const policy = await getDatabase().updatePolicies.getById(id, user.userId);

    if (!policy) {
      return NextResponse.json(
        { error: 'Policy not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      policy: policy as unknown as AppUpdatePolicy,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/update-policies/[id]
 * Update a specific policy
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;
    const body = await request.json();
    const db = getDatabase();

    // Read it first so the validation below can fall back to what is already
    // stored: a PATCH that only flips policy_type must not have to resend the
    // pinned version or the deployment config.
    const existingPolicy = await db.updatePolicies.getById(id, user.userId);

    if (!existingPolicy) {
      return NextResponse.json(
        { error: 'Policy not found' },
        { status: 404 }
      );
    }

    // Validate policy type if provided
    if (body.policy_type) {
      const validPolicyTypes: UpdatePolicyType[] = ['auto_update', 'notify', 'ignore', 'pin_version'];
      if (!validPolicyTypes.includes(body.policy_type)) {
        return NextResponse.json(
          { error: `Invalid policy_type. Must be one of: ${validPolicyTypes.join(', ')}` },
          { status: 400 }
        );
      }

      // Validate constraints based on policy type
      if (body.policy_type === 'pin_version' && !body.pinned_version && !existingPolicy.pinned_version) {
        return NextResponse.json(
          { error: 'pinned_version is required for pin_version policy' },
          { status: 400 }
        );
      }

      if (body.policy_type === 'auto_update' && !body.deployment_config && !existingPolicy.deployment_config) {
        return NextResponse.json(
          { error: 'deployment_config is required for auto_update policy' },
          { status: 400 }
        );
      }
    }

    // Only the fields the client actually sent; the adapter leaves the rest of
    // the row alone and stamps updated_at itself.
    const updateData: UpdatePolicyPatch = {};

    if (body.policy_type !== undefined) updateData.policy_type = body.policy_type;
    if (body.pinned_version !== undefined) updateData.pinned_version = body.pinned_version;
    if (body.deployment_config !== undefined) updateData.deployment_config = body.deployment_config;
    if (body.is_enabled !== undefined) updateData.is_enabled = body.is_enabled;
    if (body.original_upload_history_id !== undefined) {
      updateData.original_upload_history_id = body.original_upload_history_id;
    }

    // Re-enabling is the operator saying the app is fine again, so the circuit
    // breaker starts over rather than tripping on the old failure count.
    if (body.is_enabled === true) {
      updateData.consecutive_failures = 0;
    }

    const policy = await db.updatePolicies.update(id, user.userId, updateData);

    if (!policy) {
      return NextResponse.json(
        { error: 'Policy not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      policy: policy as unknown as AppUpdatePolicy,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/update-policies/[id]
 * Delete a specific policy
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Scoped to the owning user, so a policy of someone else's reads as
    // "not found" rather than being removed.
    const deleted = await getDatabase().updatePolicies.deleteById(id, user.userId);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Policy not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      deleted: true,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
