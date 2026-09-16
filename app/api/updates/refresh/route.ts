/**
 * Updates Refresh API Route
 * POST - Run an on-demand update scan and refresh cached update results
 */

import { NextRequest, NextResponse } from 'next/server';
import { storeScanForUser } from '@/lib/updates/store-scan';
import { createServerClient, isSupabaseServerConfigured } from '@/lib/supabase';
import { getDatabase } from '@/lib/db';
import { parseAccessToken } from '@/lib/auth-utils';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { GET as getLiveIntuneUpdates } from '@/app/api/intune/apps/updates/route';
import { notifyUserOfPendingUpdates } from '@/lib/notifications/notify-user';
import type { AppUpdateInfo } from '@/types/inventory';

interface RefreshRequestBody {
  tenant_id?: string;
}

interface LiveUpdatesResponse {
  updates: AppUpdateInfo[];
  updateCount: number;
  checkedApps?: Array<{
    app: string;
    wingetId: string | null;
    result: string;
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const user = await parseAccessToken(authHeader);
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as RefreshRequestBody;
    const requestedTenantId = body.tenant_id?.trim() || null;

    // The scan runs against the live route and the results are cached through
    // the db abstraction, so both work without Supabase. Only MSP tenant
    // resolution and the notification fan-out below still need it.
    const supabase = isSupabaseServerConfigured() ? createServerClient() : null;
    const db = getDatabase();

    let tenantId = user.tenantId;
    if (supabase) {
      const tenantResolution = await resolveTargetTenantId({
        supabase,
        userId: user.userId,
        tokenTenantId: user.tenantId,
        requestedTenantId,
      });

      if (tenantResolution.errorResponse) {
        return tenantResolution.errorResponse;
      }

      tenantId = tenantResolution.tenantId;
    }

    if (!authHeader) {
      return NextResponse.json(
        { error: 'Authentication header is required' },
        { status: 401 }
      );
    }

    // Reuse the live Intune matching route, then sync results into update_check_results.
    // The live route calls the Graph API list endpoint which returns largeIcon data inline.
    const forwardHeaders = new Headers({
      Authorization: authHeader,
    });
    if (requestedTenantId && requestedTenantId !== user.tenantId) {
      forwardHeaders.set('X-MSP-Tenant-Id', requestedTenantId);
    }

    const liveRequest = new NextRequest(
      `${request.nextUrl.origin}/api/intune/apps/updates`,
      { headers: forwardHeaders }
    );
    const liveResponse = await getLiveIntuneUpdates(liveRequest);

    if (!liveResponse.ok) {
      const errorBody = await liveResponse.json().catch(() => ({ error: 'Live update check failed' }));
      return NextResponse.json(errorBody, { status: liveResponse.status });
    }

    const liveData = (await liveResponse.json()) as LiveUpdatesResponse;
    const now = new Date().toISOString();

    // Per-user state that the scan cannot know (dismissals, notifications) is
    // carried by the shared writer, which the scheduled refresh uses too.
    let stored;
    try {
      stored = await storeScanForUser({
        userId: user.userId,
        tenantId,
        updates: liveData.updates,
        now,
      });
    } catch (storeError) {
      const message = storeError instanceof Error ? storeError.message : 'unknown error';
      return NextResponse.json(
        { error: `Failed to store updates: ${message}` },
        { status: 500 }
      );
    }

    // Near-immediate notifications: if this refresh surfaced any new or changed
    // update, deliver to the user's channels now instead of waiting for the
    // daily cron. Force-send regardless of the user's email frequency, since
    // they just ran an on-demand check. Failures here must not fail the
    // refresh; the daily cron remains the backstop.
    const hasPendingNotifications = stored.pendingNotifications > 0;
    let notified: { emailsSent: number; webhooksSent: number } | undefined;
    // Webhooks reach the user without Supabase - only their storage ever
    // needed it - so this no longer waits for a Supabase client. Email and the
    // notification centre stay Supabase-only and are skipped inside.
    if (hasPendingNotifications) {
      try {
        const res = await notifyUserOfPendingUpdates(supabase, user.userId, {
          respectFrequency: false,
        });
        notified = { emailsSent: res.emailsSent, webhooksSent: res.webhooksSent };
      } catch (notifyError) {
        console.error(
          'On-demand update notification failed:',
          notifyError instanceof Error ? notifyError.message : notifyError
        );
      }
    }

    const removedCount = stored.removedCount;

    return NextResponse.json({
      success: true,
      refreshedCount: stored.refreshedCount,
      removedCount,
      ...(notified ? { notified } : {}),
      updateCount: liveData.updateCount,
      matchingSummary: {
        totalChecked: liveData.checkedApps?.length || 0,
        noMatch: liveData.checkedApps?.filter((item) => item.result === 'No match found').length || 0,
        lowConfidenceSkipped: liveData.checkedApps?.filter((item) => item.result.includes('Low confidence')).length || 0,
        packageNotInCache: liveData.checkedApps?.filter((item) => item.result === 'Package not in cache').length || 0,
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
