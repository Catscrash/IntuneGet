import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { parseAccessToken } from '@/lib/auth-utils';
import {
  readEffectiveSettings,
  SHARED_SETTINGS_ROW_ID,
  splitSettingsUpdate,
} from '@/lib/user-settings-store';
import {
  DEFAULT_USER_SETTINGS,
  resolveAppDescriptionSuffix,
  resolveVirusTotalMaliciousThreshold,
} from '@/types/user-settings';
import type { UserSettings, UserSettingsUpdate } from '@/types/user-settings';

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isThemeMode(value: unknown): value is UserSettings['theme'] {
  return value === 'light' || value === 'dark';
}

function isStoredSettings(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function isViewMode(value: unknown): value is UserSettings['viewMode'] {
  return value === 'grid' || value === 'list';
}

function sanitizeSettings(payload: Record<string, unknown>): UserSettingsUpdate {
  const updates: UserSettingsUpdate = {};

  if (isThemeMode(payload.theme)) {
    updates.theme = payload.theme;
  }

  if (isBoolean(payload.sidebarCollapsed)) {
    updates.sidebarCollapsed = payload.sidebarCollapsed;
  }

  if (typeof payload.selectedTenantId === 'string' || payload.selectedTenantId === null) {
    updates.selectedTenantId = payload.selectedTenantId;
  }

  if (isBoolean(payload.cartAutoOpenOnAdd)) {
    updates.cartAutoOpenOnAdd = payload.cartAutoOpenOnAdd;
  }

  if (isViewMode(payload.viewMode)) {
    updates.viewMode = payload.viewMode;
  }

  if (isBoolean(payload.quickStartDismissed)) {
    updates.quickStartDismissed = payload.quickStartDismissed;
  }

  if (isBoolean(payload.onboardingCompleted)) {
    updates.onboardingCompleted = payload.onboardingCompleted;
  }

  if (isBoolean(payload.carryOverAssignments)) {
    updates.carryOverAssignments = payload.carryOverAssignments;
  }

  if (isBoolean(payload.supersedePreviousApp)) {
    updates.supersedePreviousApp = payload.supersedePreviousApp;
  }

  if (isBoolean(payload.allowAvailableUninstall)) {
    updates.allowAvailableUninstall = payload.allowAvailableUninstall;
  }

  // Not a boolean like the rest, and it is read back through the same
  // sanitizer - so a key missing here is dropped on save *and* on load, and
  // the setting silently has no effect.
  if (payload.virusTotalMaliciousThreshold !== undefined) {
    updates.virusTotalMaliciousThreshold = resolveVirusTotalMaliciousThreshold(
      payload.virusTotalMaliciousThreshold
    );
  }

  if (payload.appDescriptionSuffix !== undefined) {
    updates.appDescriptionSuffix = resolveAppDescriptionSuffix(
      payload.appDescriptionSuffix
    );
  }

  return updates;
}

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // user_settings is a plain per-user JSON blob and exists in both backends,
    // so this goes through the db abstraction. It previously called
    // createServerClient() unconditionally, which throws without Supabase - so
    // in a self-hosted install these settings could never be read or saved,
    // and the update path silently fell back to "carry over off, no
    // supersedence" no matter what the toggles showed.
    // Deployment-wide keys come from the shared row, personal ones from this
    // user's; see lib/user-settings-store.ts for which is which.
    const stored = await readEffectiveSettings(getDatabase(), user.userId);

    const sanitizedStoredSettings = isStoredSettings(stored)
      ? sanitizeSettings(stored as Record<string, unknown>)
      : {};
    const hasStoredSettings = Object.keys(sanitizedStoredSettings).length > 0;

    const merged = {
      ...DEFAULT_USER_SETTINGS,
      ...sanitizedStoredSettings,
    };

    return NextResponse.json({
      settings: merged,
      hasStoredSettings,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const payload = (await request.json()) as Record<string, unknown>;
    const settingsUpdate = sanitizeSettings(payload);

    if (Object.keys(settingsUpdate).length === 0) {
      return NextResponse.json(
        { error: 'No valid settings provided' },
        { status: 400 }
      );
    }

    // The adapter merges read-and-write in one step, so a concurrent save
    // cannot merge onto a stale base and drop the other one's keys.
    const { shared, personal } = splitSettingsUpdate(settingsUpdate);
    let mergedRow: Record<string, unknown>;
    try {
      const db = getDatabase();
      const [personalRow] = await Promise.all([
        Object.keys(personal).length > 0
          ? db.userSettings.merge(user.userId, personal)
          : db.userSettings.get(user.userId).then((row) => row ?? {}),
        Object.keys(shared).length > 0
          ? db.userSettings.merge(SHARED_SETTINGS_ROW_ID, shared)
          : Promise.resolve({}),
      ]);
      // Answer with what now applies to this user, not with one of the rows:
      // a shared key just written has to come back even though it lives
      // elsewhere, or the page would show the old value until a reload.
      mergedRow = { ...personalRow, ...shared };
    } catch {
      return NextResponse.json(
        { error: 'Failed to update user settings' },
        { status: 500 }
      );
    }

    const updatedSettings = sanitizeSettings(
      isStoredSettings(mergedRow) ? mergedRow : (settingsUpdate as Record<string, unknown>)
    );

    return NextResponse.json({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        ...updatedSettings,
      },
      hasStoredSettings: true,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
