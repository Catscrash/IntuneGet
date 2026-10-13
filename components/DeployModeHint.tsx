'use client';

import { AlertTriangle } from 'lucide-react';
import {
  interactiveOnlyFeaturesSuppressedByDeployMode,
  type InteractiveOnlyFeature,
  type PSADTConfig,
} from '@/types/psadt';

const FEATURE_EFFECTS: Record<InteractiveOnlyFeature, string> = {
  closePrompt: 'running apps are closed without the close prompt',
  deferral: 'users cannot defer the installation',
};

interface DeployModeHintProps {
  config: Pick<PSADTConfig, 'deployMode' | 'showClosePrompt' | 'allowDefer'>;
  onSwitchToInteractive: () => void;
  /** Only warn about these features, e.g. deferral inside the Deferral section. */
  features?: InteractiveOnlyFeature[];
}

/** Warns when Silent/NonInteractive deploy mode would suppress configured user dialogs. */
export function DeployModeHint({ config, onSwitchToInteractive, features }: DeployModeHintProps) {
  const suppressed = interactiveOnlyFeaturesSuppressedByDeployMode(config)
    .filter((feature) => !features || features.includes(feature));
  if (suppressed.length === 0) return null;

  const mode = config.deployMode || 'Silent';
  const effects = suppressed.map((feature) => FEATURE_EFFECTS[feature]).join(' and ');

  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
      <div className="space-y-2 text-xs text-text-secondary">
        <p>
          Deploy mode is {mode}, so PSADT shows no dialogs: {effects}. Use Interactive to show them to
          the signed-in user.
        </p>
        <button
          type="button"
          onClick={onSwitchToInteractive}
          className="font-medium text-amber-400 hover:text-amber-300 underline underline-offset-2"
        >
          Switch to Interactive
        </button>
      </div>
    </div>
  );
}
