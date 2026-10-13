// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
});
vi.mock('@/components/providers/UserSettingsProvider', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@/components/AssignmentConfig', () => ({ AssignmentConfig: () => null }));
vi.mock('@/components/CategoryConfig', () => ({ CategoryConfig: () => null }));
vi.mock('@/components/DependencyConfig', () => ({ DependencyConfig: () => null }));
vi.mock('@/components/EspProfileSelector', () => ({ EspProfileSelector: () => null }));
vi.mock('@/components/updates/CartUpdatePolicyPicker', () => ({ CartUpdatePolicyPicker: () => null }));
import { CartItemConfig } from './CartItemConfig';
import { useCartStore } from '@/stores/cart-store';
import { DEFAULT_PSADT_CONFIG, type PSADTConfig } from '@/types/psadt';
import type { Win32CartItem } from '@/types/upload';

let root: Root;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ''; });

const item = (psadt: Partial<PSADTConfig> = {}): Win32CartItem => ({
  id: 'edge', addedAt: '2026-10-10', appSource: 'win32',
  wingetId: 'Microsoft.Edge', displayName: 'Microsoft Edge', publisher: 'Microsoft', version: '149.0.4022.98',
  architecture: 'x64', installScope: 'machine', installerType: 'wix', installerUrl: 'https://example.test/edge.msi', installerSha256: 'a'.repeat(64),
  installCommand: 'msiexec /i "edge.msi" /qn', uninstallCommand: 'msiexec /x "{GUID}" /qn', detectionRules: [],
  psadtConfig: { ...structuredClone(DEFAULT_PSADT_CONFIG), ...psadt },
});

async function render(cart: Win32CartItem) {
  useCartStore.setState({ items: [cart] });
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(createElement(CartItemConfig, { item: cart, onClose: vi.fn() })));
}
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(label))!;
const open = (section: string) => act(async () => button(section).click());
const save = () => act(async () => button('Save Changes').click());

describe('cart item deploy mode', () => {
  it('offers Interactive as a deploy mode', async () => {
    // Installation Behavior is the section expanded by default.
    await render(item());
    const options = [...document.querySelectorAll('option')].map(option => option.value);
    expect(options).toContain('Interactive');
  });

  it('warns in the deferral section when Silent would suppress deferrals and switches to Interactive', async () => {
    await render(item({ allowDefer: true }));
    await open('Deferral Settings');
    expect(document.body.textContent).toContain('users cannot defer the installation');
    await act(async () => button('Switch to Interactive').click());
    expect(button('Switch to Interactive')).toBeUndefined();
    await save();
    expect(useCartStore.getState().items[0].psadtConfig.deployMode).toBe('Interactive');
  });

  it('warns under the deploy mode when Silent would suppress the close prompt', async () => {
    await render(item({ showClosePrompt: true }));
    expect(document.body.textContent).toContain('running apps are closed without the close prompt');
    expect(button('Switch to Interactive')).toBeDefined();
  });

  it('does not warn when no user dialogs are configured', async () => {
    await render(item());
    expect(document.body.textContent).toContain('Deploy mode');
    expect(button('Switch to Interactive')).toBeUndefined();
  });
});
