import { describe, expect, it } from 'vitest';
import { interactiveOnlyFeaturesSuppressedByDeployMode } from './psadt';

describe('interactiveOnlyFeaturesSuppressedByDeployMode', () => {
  const dialogs = { showClosePrompt: true, allowDefer: true };

  it.each(['Silent', 'NonInteractive', undefined] as const)('reports dialogs suppressed by %s', (deployMode) => {
    expect(interactiveOnlyFeaturesSuppressedByDeployMode({ ...dialogs, deployMode })).toEqual(['closePrompt', 'deferral']);
  });

  it.each(['Interactive', 'Auto'] as const)('reports nothing for %s', (deployMode) => {
    expect(interactiveOnlyFeaturesSuppressedByDeployMode({ ...dialogs, deployMode })).toEqual([]);
  });

  it('reports only the configured features', () => {
    expect(interactiveOnlyFeaturesSuppressedByDeployMode({ deployMode: 'Silent', showClosePrompt: false, allowDefer: true }))
      .toEqual(['deferral']);
    expect(interactiveOnlyFeaturesSuppressedByDeployMode({ deployMode: 'Silent', showClosePrompt: false, allowDefer: false }))
      .toEqual([]);
  });
});
