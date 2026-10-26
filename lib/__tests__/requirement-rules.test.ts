import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { buildCartItemRequirementRules } from '@/lib/requirement-rules';
import type { RequirementRule } from '@/types/intune';
import type { PackageAssignment } from '@/types/upload';

const updateOnlyAssignments: PackageAssignment[] = [
  { type: 'allDevices', intent: 'updateOnly' },
];

const customScript = [
  'if (Test-Path "C:\\Program Files\\Contoso\\app.exe") {',
  '    Write-Output "True"',
  '}',
].join('\r\n');

function decodeScript(rule: RequirementRule | undefined): string {
  if (rule?.['@odata.type'] !== '#microsoft.graph.win32LobAppPowerShellScriptRule') {
    throw new Error('Expected a PowerShell script requirement rule');
  }
  return Buffer.from(rule.scriptContent, 'base64').toString('utf8');
}

describe('buildCartItemRequirementRules', () => {
  it('builds an MSI registry requirement from the product code', () => {
    const rules = buildCartItemRequirementRules(
      'Contoso App',
      'msi',
      '{PRODUCT-CODE}',
      updateOnlyAssignments
    );

    expect(rules).toEqual([
      expect.objectContaining({
        '@odata.type': '#microsoft.graph.win32LobAppRegistryRule',
        ruleType: 'requirement',
        keyPath: expect.stringContaining('{PRODUCT-CODE}'),
        operationType: 'exists',
      }),
    ]);
  });

  it('builds an uninstall-registry script requirement for an EXE', () => {
    const rules = buildCartItemRequirementRules(
      'Contoso App',
      'exe',
      undefined,
      updateOnlyAssignments
    );
    const scriptRule = rules?.[0];

    expect(scriptRule?.['@odata.type']).toBe(
      '#microsoft.graph.win32LobAppPowerShellScriptRule'
    );
    if (scriptRule?.['@odata.type'] !== '#microsoft.graph.win32LobAppPowerShellScriptRule') {
      throw new Error('Expected a PowerShell script requirement rule');
    }
    expect(Buffer.from(scriptRule.scriptContent, 'base64').toString('utf8')).toContain(
      "DisplayName -like '*Contoso App*'"
    );
  });

  it.each([
    ['an MSI', 'msi', '{PRODUCT-CODE}'],
    ['an EXE', 'exe', undefined],
  ] as const)('uses a custom script instead of the generated check for %s', (_, installerType, productCode) => {
    const rules = buildCartItemRequirementRules(
      'Contoso App',
      installerType,
      productCode,
      updateOnlyAssignments,
      customScript
    );

    expect(rules).toEqual([
      expect.objectContaining({
        '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRule',
        ruleType: 'requirement',
        enforceSignatureCheck: false,
        runAs32Bit: false,
        runAsAccount: 'system',
        operationType: 'boolean',
        operator: 'equal',
        comparisonValue: 'True',
      }),
    ]);
    const script = decodeScript(rules?.[0]);
    expect(script).toBe(customScript);
    expect(script).not.toContain('DisplayName -like');
  });

  it.each([undefined, '', '  \r\n  '])('keeps the generated checks when the custom script is %j', (script) => {
    const msiRules = buildCartItemRequirementRules(
      'Contoso App',
      'msi',
      '{PRODUCT-CODE}',
      updateOnlyAssignments,
      script
    );
    const exeRules = buildCartItemRequirementRules(
      'Contoso App',
      'exe',
      undefined,
      updateOnlyAssignments,
      script
    );

    expect(msiRules).toEqual(
      buildCartItemRequirementRules('Contoso App', 'msi', '{PRODUCT-CODE}', updateOnlyAssignments)
    );
    expect(msiRules?.[0]?.['@odata.type']).toBe('#microsoft.graph.win32LobAppRegistryRule');
    expect(decodeScript(exeRules?.[0])).toContain("DisplayName -like '*Contoso App*'");
  });

  it('ignores a custom script when no assignment is updateOnly', () => {
    expect(
      buildCartItemRequirementRules(
        'Contoso App',
        'exe',
        undefined,
        [{ type: 'allDevices', intent: 'required' }],
        customScript
      )
    ).toBeUndefined();
  });

  it('returns undefined when no assignment is updateOnly', () => {
    expect(
      buildCartItemRequirementRules('Contoso App', 'exe', undefined, [
        { type: 'allDevices', intent: 'required' },
      ])
    ).toBeUndefined();
  });
});
