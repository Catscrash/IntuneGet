/**
 * Where each user setting lives.
 *
 * Most of the General tab describes how *this deployment* packages apps -
 * whether assignments carry over, whether the previous version is superseded,
 * what antivirus finding blocks a package, what signature end users read. Those
 * are house rules, not personal taste: with four admins on one instance, a
 * package would otherwise be built differently depending on who clicked
 * Deploy, which is how this deployment already ended up with divergent values.
 *
 * They are therefore stored once, under a shared row, and everyone sees and
 * edits the same values. Genuinely personal preferences - theme, sidebar, view
 * mode, whether the cart opens on add - stay in the signed-in user's own row.
 */

import type { DatabaseAdapter } from '@/lib/db/types';
import type { UserSettingsUpdate } from '@/types/user-settings';

/**
 * Row id for the shared settings. Not a user id: real ones are UUIDs, so this
 * cannot collide with a person's row.
 */
export const SHARED_SETTINGS_ROW_ID = '__server__';

/** Settings that describe the deployment rather than the person. */
export const SHARED_SETTING_KEYS = [
  'carryOverAssignments',
  'supersedePreviousApp',
  'allowAvailableUninstall',
  'appDescriptionSuffix',
  'virusTotalMaliciousThreshold',
] as const;

export type SharedSettingKey = (typeof SHARED_SETTING_KEYS)[number];

export function isSharedSettingKey(key: string): key is SharedSettingKey {
  return (SHARED_SETTING_KEYS as readonly string[]).includes(key);
}

/** Split an incoming update into the row each key belongs to. */
export function splitSettingsUpdate(update: UserSettingsUpdate): {
  shared: Record<string, unknown>;
  personal: Record<string, unknown>;
} {
  const shared: Record<string, unknown> = {};
  const personal: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(update)) {
    if (isSharedSettingKey(key)) {
      shared[key] = value;
    } else {
      personal[key] = value;
    }
  }

  return { shared, personal };
}

/**
 * The settings that apply to this user: their own row, with the shared values
 * laid over it.
 *
 * A shared key the shared row has never carried falls back to the user's own
 * stored value rather than to the default, so an instance configured before
 * these became shared keeps behaving the same. The first save of that key
 * promotes it, and from then on everyone sees one value.
 */
export async function readEffectiveSettings(
  db: DatabaseAdapter,
  userId: string
): Promise<Record<string, unknown>> {
  const [personal, shared] = await Promise.all([
    db.userSettings.get(userId),
    db.userSettings.get(SHARED_SETTINGS_ROW_ID),
  ]);

  const merged: Record<string, unknown> = { ...(personal ?? {}) };

  for (const key of SHARED_SETTING_KEYS) {
    if (shared && shared[key] !== undefined) {
      merged[key] = shared[key];
    }
  }

  return merged;
}
