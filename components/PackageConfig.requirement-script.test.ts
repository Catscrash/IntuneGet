// @vitest-environment happy-dom
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Win32CartItem } from '@/types/upload';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
});

vi.mock('@/hooks/use-packages', () => ({
  useLocaleVariants: () => ({ data: { variants: [] }, isSuccess: true }),
  usePackageManifest: () => ({ data: undefined, isFetching: false, error: null }),
}));
vi.mock('@/components/providers/UserSettingsProvider', () => ({ useUserSettings: () => ({ settings: { carryOverAssignments: false } }) }));
vi.mock('@/hooks/use-update-app-settings', () => ({ useUpdateAppSettings: () => ({ isUpdating: false }) }));
vi.mock('@/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('@/components/AssignmentConfig', async () => {
  const { createElement: h } = await import('react');
  return {
    AssignmentConfig: ({ onChange }: { onChange: (assignments: unknown[]) => void }) => h('div', null,
      h('button', { type: 'button', onClick: () => onChange([{ type: 'allDevices', intent: 'updateOnly' }]) }, 'Use Update Only'),
      h('button', { type: 'button', onClick: () => onChange([{ type: 'allUsers', intent: 'available' }]) }, 'Use Available'),
    ),
  };
});
vi.mock('@/components/CategoryConfig', () => ({ CategoryConfig: () => null }));
vi.mock('@/components/DependencyConfig', () => ({ DependencyConfig: () => null }));
vi.mock('@/components/EspProfileSelector', () => ({ EspProfileSelector: () => null }));
vi.mock('@/components/updates/CartUpdatePolicyPicker', () => ({ CartUpdatePolicyPicker: () => null }));

import { PackageConfig } from './PackageConfig';
import { useCartStore } from '@/stores/cart-store';

let root: Root;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCRIPT_LABEL = 'Update Only requirement script';
const installer = { architecture: 'x64' as const, type: 'exe' as const, url: 'https://example.test/setup.exe', sha256: 'B'.repeat(64), scope: 'machine' as const };
const pkg = { id: 'Example.App', name: 'Example App', publisher: 'Example', version: '2.0' };
const customScript = 'if (Test-Path "C:\\Program Files\\Example\\app.exe") { Write-Output "True" }';

async function render() {
  await act(async () => root.render(createElement(PackageConfig, {
    package: pkg, installers: [installer], versions: ['2.0'], onClose: vi.fn(),
  } as Parameters<typeof PackageConfig>[0])));
}

function buttonWithText(text: string) {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));
}

function scriptField() {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === SCRIPT_LABEL);
  return label ? document.getElementById(label.htmlFor) as HTMLTextAreaElement : null;
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error('Element not found');
  await act(async () => el.click());
}

async function typeScript(value: string) {
  const textarea = scriptField();
  if (!textarea) throw new Error('No requirement script field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function save() {
  await click(buttonWithText('Add to Selection'));
  return useCartStore.getState().items[0] as Win32CartItem | undefined;
}

function decodedRequirementScript(item: Win32CartItem | undefined) {
  const rule = item?.requirementRules?.[0];
  if (rule?.['@odata.type'] !== '#microsoft.graph.win32LobAppPowerShellScriptRule') {
    throw new Error('Expected a PowerShell script requirement rule');
  }
  return Buffer.from(rule.scriptContent, 'base64').toString('utf8');
}

beforeEach(async () => {
  useCartStore.setState({ items: [] });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render();
  await click(buttonWithText('Assignment Configuration'));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

describe('custom Update Only requirement script', () => {
  it('appears only with an Update Only assignment', async () => {
    expect(scriptField()).toBeNull();
    await click(buttonWithText('Use Update Only'));
    expect(scriptField()).not.toBeNull();
    await click(buttonWithText('Use Available'));
    expect(scriptField()).toBeNull();
  });

  it('saves the custom script and builds the requirement rule from it', async () => {
    await click(buttonWithText('Use Update Only'));
    await typeScript(customScript);

    const item = await save();
    expect(item?.customRequirementScript).toBe(customScript);
    expect(decodedRequirementScript(item)).toBe(customScript);
  });

  it('starts from the generated script on request', async () => {
    await click(buttonWithText('Use Update Only'));
    await click(buttonWithText('Start from generated script'));
    expect(scriptField()?.value).toContain("DisplayName -like '*Example App*'");
  });

  it('keeps the generated check when the field is empty', async () => {
    await click(buttonWithText('Use Update Only'));

    const item = await save();
    expect(item).not.toHaveProperty('customRequirementScript', expect.anything());
    expect(decodedRequirementScript(item)).toContain("DisplayName -like '*Example App*'");
  });

  it('drops the script when the assignment no longer uses Update Only', async () => {
    await click(buttonWithText('Use Update Only'));
    await typeScript(customScript);
    await click(buttonWithText('Use Available'));

    const item = await save();
    expect(item?.customRequirementScript).toBeUndefined();
    expect(item?.requirementRules).toBeUndefined();
  });
});
