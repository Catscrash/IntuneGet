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
};

export interface UserSettingsResponse {
  settings: UserSettings;
  hasStoredSettings?: boolean;
}
