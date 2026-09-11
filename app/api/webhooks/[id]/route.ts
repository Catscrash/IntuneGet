/**
 * Individual Webhook API Routes
 * GET - Get a specific webhook configuration
 * PUT - Update a webhook configuration
 * DELETE - Delete a webhook configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { parseAccessToken } from '@/lib/auth-utils';
import { validateWebhookTarget } from '@/lib/webhooks/egress';
import type {
  WebhookConfiguration,
  WebhookConfigurationUpdate,
} from '@/types/notifications';
import type { DatabaseAdapter } from '@/lib/db/types';

type WebhookPatch = Parameters<DatabaseAdapter['webhooks']['update']>[2];

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/webhooks/[id]
 * Get a specific webhook configuration
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
    // client sends, so one user must not be able to read another's webhook -
    // secret included - by guessing it.
    const webhook = await getDatabase().webhooks.getById(id, user.userId);

    if (!webhook) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      );
    }

    // Mask secret in response
    const sanitizedWebhook = {
      ...webhook,
      secret: webhook.secret ? '********' : null,
    };

    return NextResponse.json({ webhook: sanitizedWebhook });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/webhooks/[id]
 * Update a webhook configuration
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;
    const body: WebhookConfigurationUpdate = await request.json();

    // Validate URL if provided
    if (body.url) {
      const urlValidation = await validateWebhookTarget(body.url);
      if (!urlValidation.valid) {
        return NextResponse.json(
          { error: urlValidation.error || 'Invalid webhook URL' },
          { status: 400 }
        );
      }
    }

    // Validate webhook type if provided
    if (
      body.webhook_type &&
      !['slack', 'teams', 'discord', 'custom'].includes(body.webhook_type)
    ) {
      return NextResponse.json(
        { error: 'Invalid webhook type' },
        { status: 400 }
      );
    }

    const db = getDatabase();

    // Only the fields the client actually sent; the adapter leaves the rest of
    // the row alone and stamps updated_at itself.
    const updateData: WebhookPatch = {};

    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.url !== undefined) updateData.url = body.url;
    if (body.webhook_type !== undefined) updateData.webhook_type = body.webhook_type;
    if (body.headers !== undefined) updateData.headers = body.headers;
    if (body.is_enabled !== undefined) updateData.is_enabled = body.is_enabled;

    // Handle secret update (only update if explicitly provided, including null)
    if ('secret' in body) {
      updateData.secret = body.secret;
    }

    // The update is itself scoped to the owner, so a webhook belonging to
    // someone else reads as "not found" rather than being written to.
    const webhook = await db.webhooks.update(id, user.userId, updateData);

    if (!webhook) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      );
    }

    // Mask secret in response
    const sanitizedWebhook = {
      ...webhook,
      secret: webhook.secret ? '********' : null,
    };

    return NextResponse.json({ webhook: sanitizedWebhook });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/webhooks/[id]
 * Delete a webhook configuration
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

    // Scoped to the owning user, so someone else's webhook reads as
    // "not found" rather than being removed.
    const deleted = await getDatabase().webhooks.deleteById(id, user.userId);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
