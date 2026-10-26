'use client';

import { useId } from 'react';
import { FileCode } from 'lucide-react';
import { generateUninstallRegistryScript } from '@/lib/requirement-rules';

interface CustomRequirementScriptEditorProps {
  displayName: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Editor for a PowerShell requirement script that replaces the generated
 * Update Only check. Shown only while an assignment uses Update Only.
 */
export function CustomRequirementScriptEditor({ displayName, value, onChange }: CustomRequirementScriptEditorProps) {
  const id = useId();
  // Intune runs the script in Windows PowerShell, which reads a script file
  // without a byte order mark in the system code page.
  const hasNonAscii = /[^\x00-\x7F]/.test(value);

  return (
    <div className="space-y-2 pt-4 border-t border-overlay/10">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-script`} className="block text-sm font-medium text-text-secondary">
          Update Only requirement script
        </label>
        {!value.trim() && (
          <button
            type="button"
            onClick={() => onChange(generateUninstallRegistryScript(displayName))}
            className="flex items-center gap-1.5 text-xs text-accent-cyan hover:text-accent-cyan/80 transition-colors"
          >
            <FileCode className="w-3.5 h-3.5" />
            Start from generated script
          </button>
        )}
      </div>
      <textarea
        id={`${id}-script`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={value.trim() ? 12 : 4}
        spellCheck={false}
        aria-describedby={`${id}-help`}
        placeholder="Leave empty to use the generated check"
        className="w-full px-3 py-2 bg-bg-elevated border border-overlay/15 rounded-lg text-text-primary text-xs font-mono resize-y"
      />
      <p id={`${id}-help`} className="text-text-muted text-xs">
        Replaces the generated check that limits Update Only installs to devices that already have the app.
        The script runs as SYSTEM in 64-bit PowerShell and must write True when the app is installed.
      </p>
      {hasNonAscii && (
        <p role="alert" className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
          The script contains non-ASCII characters. Windows PowerShell may read them incorrectly; use only ASCII characters where possible.
        </p>
      )}
    </div>
  );
}
