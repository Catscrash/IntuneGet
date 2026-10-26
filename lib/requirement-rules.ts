/**
 * Requirement Rule Generator
 * Generates Intune requirement rules that check for app EXISTENCE on the device.
 *
 * Used by the "Update Only" assignment mode: the app is assigned as "required"
 * but with a requirement rule that gates installation to devices where the app
 * is already present. Intune evaluates: requirement met (app exists) AND
 * detection not met (new version not installed) = proceed with install (update).
 *
 * IMPORTANT: These rules detect the app using standard Windows methods
 * (uninstall registry, file paths), NOT the IntuneGet registry marker.
 * The IntuneGet marker only exists after IntuneGet deploys an app -- it would
 * NOT exist on devices where the app was discovered/installed natively.
 */

import type {
  RequirementRule,
  RegistryRequirementRule,
  ScriptRequirementRule,
} from '@/types/intune';
import type { WingetInstallerType, WingetScope } from '@/types/winget';
import type { PackageAssignment } from '@/types/upload';
import { psAsciiStringExpression, psCommentContent } from '@/lib/powershell-encoding';

export function buildCartItemRequirementRules(
  displayName: string,
  installerType: WingetInstallerType,
  productCode: string | undefined,
  assignments: PackageAssignment[] | undefined,
  customScript?: string
): RequirementRule[] | undefined {
  if (!hasUpdateOnlyAssignment(assignments)) {
    return undefined;
  }

  // An administrator's own script replaces the generated existence check.
  const script = effectiveCustomRequirementScript(assignments, customScript);
  if (script) {
    return [generateCustomScriptRequirementRule(displayName, script)];
  }

  return generateRequirementRules(displayName, installerType, productCode);
}

export function hasUpdateOnlyAssignment(assignments: PackageAssignment[] | undefined): boolean {
  return Boolean(assignments?.some((assignment) => assignment.intent === 'updateOnly'));
}

/**
 * The custom requirement script a cart item keeps: only one that is not blank
 * and only while an Update Only assignment uses it, so it never leaks into an
 * Available deployment of the same app.
 */
export function effectiveCustomRequirementScript(
  assignments: PackageAssignment[] | undefined,
  customScript: string | undefined
): string | undefined {
  return hasUpdateOnlyAssignment(assignments) && customScript?.trim() ? customScript : undefined;
}

/**
 * Generate requirement rules that check whether the app is already installed.
 *
 * Strategy:
 * - MSI apps with a known product code: use a registry rule checking the
 *   product code's uninstall key directly (most precise).
 * - All other apps: use a PowerShell script that searches the Windows
 *   uninstall registry by display name (universal).
 */
export function generateRequirementRules(
  displayName: string,
  installerType: WingetInstallerType,
  productCode?: string,
  _packageFamilyName?: string,
  _scope?: WingetScope
): RequirementRule[] {
  // MSI-specific optimization: check the product code's uninstall key directly
  if ((installerType === 'msi' || installerType === 'wix') && productCode) {
    return [generateMsiRegistryRequirementRule(productCode)];
  }

  // Universal fallback: PowerShell script searching uninstall registry by name
  return [generateUninstallRegistryScriptRule(displayName)];
}

/**
 * Generate a registry requirement rule for MSI apps.
 * Checks if the MSI product code exists in the uninstall registry.
 */
function generateMsiRegistryRequirementRule(
  productCode: string
): RegistryRequirementRule {
  return {
    '@odata.type': '#microsoft.graph.win32LobAppRegistryRule',
    ruleType: 'requirement',
    keyPath: `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productCode}`,
    check32BitOn64System: false,
    operationType: 'exists',
  };
}

/**
 * Generate a PowerShell script requirement rule that searches the Windows
 * uninstall registry for the app by display name.
 *
 * Searches:
 * - HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*
 * - HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*
 * - HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*
 *
 * Returns $true if the app is found (any version), $false otherwise.
 */
function generateUninstallRegistryScriptRule(
  displayName: string
): ScriptRequirementRule {
  return {
    '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRule',
    ruleType: 'requirement',
    displayName: `Check if ${displayName} is installed`,
    scriptContent: Buffer.from(generateUninstallRegistryScript(displayName), 'utf-8').toString('base64'),
    enforceSignatureCheck: false,
    runAs32Bit: false,
    runAsAccount: 'system',
    operationType: 'boolean',
    operator: 'equal',
    comparisonValue: 'True',
  };
}

/**
 * The PowerShell source of the generated uninstall-registry check, also
 * offered as a starting point for a custom requirement script.
 */
export function generateUninstallRegistryScript(displayName: string): string {
  // Encode the display name for PowerShell. The pattern source text is ASCII
  // only, so it reads the same whether the script is decoded as UTF-8 or ANSI.
  const namePattern = psAsciiStringExpression(`*${displayName}*`);

  const scriptLines = [
    '# Requirement rule: Check if app is already installed on this device',
    // The whole script stays ASCII; other characters in the comment become '?'.
    `# App: ${psCommentContent(displayName).replace(/[^\x20-\x7E]/g, '?')}`,
    '$ErrorActionPreference = "SilentlyContinue"',
    '',
    '$uninstallPaths = @(',
    '    "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
    '    "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
    '    "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"',
    ')',
    '',
    'foreach ($path in $uninstallPaths) {',
    '    $apps = Get-ItemProperty $path -ErrorAction SilentlyContinue |',
    `        Where-Object { $_.DisplayName -like ${namePattern} }`,
    '    if ($apps) {',
    '        Write-Output "True"',
    '        exit 0',
    '    }',
    '}',
    '',
    'Write-Output "False"',
    'exit 0',
  ];

  return scriptLines.join('\r\n');
}

/**
 * Wrap an administrator-supplied PowerShell script as a requirement rule.
 * The script must write "True" when the app is installed, like the
 * generated uninstall-registry script.
 */
function generateCustomScriptRequirementRule(
  displayName: string,
  script: string
): ScriptRequirementRule {
  return {
    '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRule',
    ruleType: 'requirement',
    displayName: `Check if ${displayName} is installed (custom script)`,
    scriptContent: Buffer.from(script, 'utf-8').toString('base64'),
    enforceSignatureCheck: false,
    runAs32Bit: false,
    runAsAccount: 'system',
    operationType: 'boolean',
    operator: 'equal',
    comparisonValue: 'True',
  };
}
