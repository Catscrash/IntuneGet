-- Allow QA evidence for packages that run PSADT with -DeployMode Interactive.
-- The constraint is otherwise unchanged from 20260809060000.

alter table public.qa_results
  drop constraint if exists qa_results_effective_configuration_check;

alter table public.qa_results
  add constraint qa_results_effective_configuration_check check (
    effective_configuration is null or (
      jsonb_typeof(effective_configuration) = 'object'
      and effective_configuration ?& array[
        'deployMode',
        'vendorSilentArguments',
        'restartBehavior',
        'promptConfiguration',
        'processCloseCount',
        'uiEvidenceExpected'
      ]
      and effective_configuration - array[
        'deployMode',
        'vendorSilentArguments',
        'restartBehavior',
        'promptConfiguration',
        'processCloseCount',
        'uiEvidenceExpected'
      ] = '{}'::jsonb
      and effective_configuration->>'deployMode' in ('Auto', 'Silent', 'NonInteractive', 'Interactive')
      and jsonb_typeof(effective_configuration->'vendorSilentArguments') in ('string', 'null')
      and length(coalesce(effective_configuration->>'vendorSilentArguments', '')) <= 4096
      and coalesce(effective_configuration->>'vendorSilentArguments', '') !~ E'[\r\n]'
      and effective_configuration->>'restartBehavior' in ('Suppress', 'Force', 'Prompt')
      and jsonb_typeof(effective_configuration->'promptConfiguration') = 'object'
      and effective_configuration->'promptConfiguration' ?& array[
        'closePrompt',
        'deferral',
        'progressDialog',
        'customPromptCount',
        'restartPrompt',
        'balloonTipCount'
      ]
      and (effective_configuration->'promptConfiguration') - array[
        'closePrompt',
        'deferral',
        'progressDialog',
        'customPromptCount',
        'restartPrompt',
        'balloonTipCount'
      ] = '{}'::jsonb
      and jsonb_typeof(effective_configuration->'promptConfiguration'->'closePrompt') = 'boolean'
      and jsonb_typeof(effective_configuration->'promptConfiguration'->'deferral') = 'boolean'
      and jsonb_typeof(effective_configuration->'promptConfiguration'->'progressDialog') = 'boolean'
      and jsonb_typeof(effective_configuration->'promptConfiguration'->'restartPrompt') = 'boolean'
      and jsonb_typeof(effective_configuration->'promptConfiguration'->'customPromptCount') = 'number'
      and (effective_configuration->'promptConfiguration'->>'customPromptCount') ~ '^\d+$'
      and (effective_configuration->'promptConfiguration'->>'customPromptCount')::numeric between 0 and 100
      and jsonb_typeof(effective_configuration->'promptConfiguration'->'balloonTipCount') = 'number'
      and (effective_configuration->'promptConfiguration'->>'balloonTipCount') ~ '^\d+$'
      and (effective_configuration->'promptConfiguration'->>'balloonTipCount')::numeric between 0 and 100
      and jsonb_typeof(effective_configuration->'processCloseCount') = 'number'
      and (effective_configuration->>'processCloseCount') ~ '^\d+$'
      and (effective_configuration->>'processCloseCount')::numeric between 0 and 100
      and jsonb_typeof(effective_configuration->'uiEvidenceExpected') = 'boolean'
    )
  );
