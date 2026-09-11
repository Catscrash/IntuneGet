export type ThemeMode = "light" | "dark";
export type ViewMode = "grid" | "list";

export interface UserSettings {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  selectedTenantId: string | null;
  cartAutoOpenOnAdd: boolean;
  viewMode: ViewMode;
  quickStartDismissed: boolean;
  onboardingCompleted: boolean;
  carryOverAssignments: boolean;
  supersedePreviousApp: boolean;
  /**
   * Let end users uninstall the app from Company Portal. Applies to
   * assignments with the "available" intent; required assignments are not
   * user-removable, so Intune ignores it there.
   */
  allowAvailableUninstall: boolean;
  /**
   * How many VirusTotal engines must flag an installer before packaging is
   * refused. 1 means a single engine is enough, which is where antivirus
   * false positives live; raising it trades that noise for less margin.
   * 0 disables the check entirely.
   *
   * The verdict itself comes from the published catalog, so this only decides
   * how to act on it - it never changes what was scanned.
   */
  virusTotalMaliciousThreshold: number;
  /**
   * Free text appended to every deployed app's Intune description, for
   * example a team signature. Empty by default - nothing is added beyond the
   * machine-readable package-id marker the duplicate guard needs.
   *
   * Visible to end users in Company Portal, so it is the operator's own words
   * rather than the tool's.
   */
  appDescriptionSuffix: string;
}

/** Kept short: it rides along in every app description. */
export const MAX_APP_DESCRIPTION_SUFFIX_LENGTH = 200;

/**
 * Coerce a stored settings value into a usable suffix.
 *
 * Control characters are dropped rather than rejected - the text goes into a
 * Graph payload, and a stray character should not fail a deployment. Newlines
 * survive so a two-line signature stays two lines.
 */
export function resolveAppDescriptionSuffix(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_USER_SETTINGS.appDescriptionSuffix;
  }
  return value
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, MAX_APP_DESCRIPTION_SUFFIX_LENGTH)
    .trimEnd();
}

/** Largest accepted threshold; VirusTotal runs on the order of 70-80 engines. */
export const MAX_VIRUSTOTAL_MALICIOUS_THRESHOLD = 100;

/**
 * Coerce a stored settings value into a usable threshold.
 *
 * Settings are an open JSON blob, so this has to survive a missing key, a
 * string from an old client, and nonsense. Anything unusable falls back to the
 * default rather than to "off" - a broken value must not silently disable a
 * security check.
 */
export function resolveVirusTotalMaliciousThreshold(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_USER_SETTINGS.virusTotalMaliciousThreshold;
  }
  return Math.min(parsed, MAX_VIRUSTOTAL_MALICIOUS_THRESHOLD);
}

export type UserSettingsUpdate = Partial<UserSettings>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  theme: "light",
  sidebarCollapsed: false,
  selectedTenantId: null,
  cartAutoOpenOnAdd: true,
  viewMode: "grid",
  quickStartDismissed: false,
  onboardingCompleted: false,
  carryOverAssignments: false,
  supersedePreviousApp: false,
  // Matches Intune's own default: an available app stays until an admin
  // removes it, unless the operator opts in.
  allowAvailableUninstall: false,
  // Unchanged behaviour until an operator decides otherwise: one engine is
  // enough to refuse.
  virusTotalMaliciousThreshold: 1,
  appDescriptionSuffix: '',
};

export interface UserSettingsResponse {
  settings: UserSettings;
  hasStoredSettings?: boolean;
}
