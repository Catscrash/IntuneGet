/**
 * Webhook Test API Route
 * POST - Send a test payload to a webhook
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { parseAccessToken } from '@/lib/auth-utils';
import { sendTestWebhook } from '@/lib/webhooks/service';
import type { WebhookConfiguration } from '@/types/notifications';
import type { DatabaseAdapter } from '@/lib/db/types';

type WebhookPatch = Parameters<DatabaseAdapter['webhooks']['update']>[2];

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/webhooks/[id]/test
 * Send a test payload to the webhook
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Through the db abstraction like the rest of the webhook routes: only
    // storing these ever needed Supabase, and sendTestWebhook() below does not
    // touch a database at all. Scoped to the owning user, since the id is the
    // only thing the client sends and the row holds an HMAC secret.
    const db = getDatabase();
    const webhook = await db.webhooks.getById(id, user.userId);

    if (!webhook) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      );
    }

    // Send test webhook
    const result = await sendTestWebhook(webhook as WebhookConfiguration);

    // Update webhook status based on result
    const statusUpdate: WebhookPatch = {};

    if (result.success) {
      statusUpdate.last_success_at = new Date().toISOString();
      statusUpdate.failure_count = 0;
    } else {
      statusUpdate.last_failure_at = new Date().toISOString();
      statusUpdate.failure_count = (webhook.failure_count || 0) + 1;
    }

    await db.webhooks.update(id, user.userId, statusUpdate);

    return NextResponse.json({
      success: result.success,
      statusCode: result.statusCode,
      error: result.error,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
