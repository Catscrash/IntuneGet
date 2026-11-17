/**
 * Trigger Updates API Route
 * POST - Manually trigger update(s) for apps
 */

import { NextRequest, NextResponse } from 'next/server';
import { DISPATCH_IDENTITY_KEY, dispatchRateLimitHold, WorkflowDispatchUnconfirmedError, WorkflowDispatchRateLimitError, WorkflowDispatchRetryStopped } from '@/lib/workflow-dispatch-rate-limit';
import { buildStoredJobWorkflowInputs, storedJobItem } from '@/lib/auto-update/stored-job-workflow-inputs';
import { createServerClient, isSupabaseServerConfigured } from '@/lib/supabase';
import { getCatalogSource } from '@/lib/catalog';
import { getDatabase } from '@/lib/db';
import { readEffectiveSettings } from '@/lib/user-settings-store';
import { parseAccessToken } from '@/lib/auth-utils';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import {
  AutoUpdateTrigger,
  getLatestInstallerInfo,
  normalizeAssignments,
  normalizeCategories,
} from '@/lib/auto-update/trigger';
import {
  isGitHubActionsConfigured,
  triggerPackagingWorkflow,
} from '@/lib/github-actions';
import { getAppConfig } from '@/lib/config';
import { getFeatureFlags } from '@/lib/features';
import { buildDeploymentConfigForApp } from '@/lib/update-policies/build-deployment-config';
import {
  classifyDeploymentTrack,
  findTrackDeployments,
  type DeploymentTrack,
} from '@/lib/update-policies/deployment-tracks';
import { compareVersions } from '@/lib/version-compare';
import { shouldSkipUpdate } from '@/types/update-policies';
import { resolveAppDescriptionSuffix } from '@/types/user-settings';
import { buildIntuneAppDescription } from '@/lib/intune-description';
import type {
  TriggerUpdateRequest,
  TriggerUpdateResponse,
  AppUpdatePolicy,
  DeploymentConfig,
} from '@/types/update-policies';
import type { Json, Database } from '@/types/database';
import { isSelfUpdatingApp } from '@/lib/self-updating-apps';
import { describeQaGateError, isQaGateError } from '@/lib/qa/gate';

// Batches of up to 10 apps run sequentially (DB lookups, job creation, and a
// workflow dispatch each); the platform default duration times out mid-batch
// and returns a non-JSON error page to the client
export const maxDuration = 300;

/**
 * POST /api/updates/trigger
 * Manually trigger update deployment for one or more apps
 */
export async function POST(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body: TriggerUpdateRequest = await request.json();

    // Validate request - either single update or bulk
    let updateRequests: { winget_id: string; tenant_id: string }[] = [];

    if (body.updates && Array.isArray(body.updates) && body.updates.length > 0) {
      updateRequests = body.updates;
    } else if (body.winget_id && body.tenant_id) {
      updateRequests = [{ winget_id: body.winget_id, tenant_id: body.tenant_id }];
    } else {
      return NextResponse.json(
        { error: 'Either winget_id/tenant_id or updates array is required' },
        { status: 400 }
      );
    }

    // Limit bulk updates
    if (updateRequests.length > 10) {
      return NextResponse.json(
        { error: 'Maximum 10 updates can be triggered at once' },
        { status: 400 }
      );
    }

    // Without Supabase there are no update policies and no auto-update
    // bookkeeping, but a manual trigger needs neither: it only has to queue a
    // packaging job, exactly as a normal deployment does. The policy round
    // trip below (create a policy, flip it to auto_update, restore it) is a
    // vehicle for AutoUpdateTrigger, not something the user asked for.
    if (!isSupabaseServerConfigured()) {
      return triggerWithoutSupabase(user, updateRequests);
    }

    const supabase = createServerClient();

    // The tenant ids come from the request body. Each one must be the
    // caller's own tenant or a customer tenant their MSP role may deploy to.
    // Rows stored earlier for a tenant are not proof of current access.
    for (const tenantId of new Set(updateRequests.map((req) => req.tenant_id))) {
      const tenantResolution = await resolveTargetTenantId({
        supabase,
        userId: user.userId,
        tokenTenantId: user.tenantId,
        requestedTenantId: tenantId,
        requiredPermission: 'deploy_apps',
      });
      if (tenantResolution.errorResponse) {
        return tenantResolution.errorResponse;
      }
    }

    // Get Supabase config for trigger
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const autoUpdateTrigger = new AutoUpdateTrigger(supabaseUrl, supabaseServiceKey);

    const response: TriggerUpdateResponse = {
      success: true,
      triggered: 0,
      failed: 0,
      results: [],
    };

    // Read the user's global update settings once for the whole batch - they
    // do not change mid-request and per-item reads add up across 10 apps
    const { data: userSettingsRow, error: userSettingsError } = await (supabase as any)
      .from('user_settings')
      .select('settings')
      .eq('user_id', user.userId)
      .maybeSingle();
    if (userSettingsError) {
      console.warn(
        `Failed to read user_settings for ${user.userId}: ${userSettingsError.message}`
      );
    }
    const userSettings = (userSettingsRow?.settings as Record<string, unknown> | null) || null;
    const globalCarryOver = Boolean(userSettings?.carryOverAssignments);
    // The operator's description suffix is composed at dispatch, as for
    // every other deployment.
    const appDescriptionSuffix = resolveAppDescriptionSuffix(
      userSettings?.appDescriptionSuffix
    );

    for (const req of updateRequests) {
      try {
        // Self-updating apps are excluded from update detection; guard here
        // too in case a stale check result from before the exclusion remains
        if (isSelfUpdatingApp(req.winget_id)) {
          response.failed++;
          response.results.push({
            winget_id: req.winget_id,
            tenant_id: req.tenant_id,
            success: false,
            error: `${req.winget_id} keeps itself up to date on the device (Click-to-Run); IntuneGet does not deploy updates for it. Refresh the updates list to remove it.`,
          });
          continue;
        }

        // Get the update check result for this app
        const { data: updateResult, error: updateError } = await supabase
          .from('update_check_results')
          .select('*')
          .eq('user_id', user.userId)
          .eq('tenant_id', req.tenant_id)
          .eq('winget_id', req.winget_id)
          .single();

        if (updateError || !updateResult) {
          response.failed++;
          response.results.push({
            winget_id: req.winget_id,
            tenant_id: req.tenant_id,
            success: false,
            error: 'Update not found',
          });
          continue;
        }

        // Get or create policy for this app
        let { data: policy } = await supabase
          .from('app_update_policies')
          .select('*')
          .eq('user_id', user.userId)
          .eq('tenant_id', req.tenant_id)
          .eq('winget_id', req.winget_id)
          .single();

        // If no policy exists, check for prior deployment to get config
        if (!policy) {
          const built = await buildDeploymentConfigForApp(supabase, {
            tenantId: req.tenant_id,
            wingetId: req.winget_id,
            latestVersion: updateResult.latest_version,
          });

          if (built.status === 'orphaned_job') {
            response.failed++;
            response.results.push({
              winget_id: req.winget_id,
              tenant_id: req.tenant_id,
              success: false,
              error: 'Could not retrieve deployment configuration',
            });
            continue;
          }

          if (built.status === 'unavailable') {
            // Distinguish missing installer data from a missing catalog
            // entry so the user knows whether waiting for the catalog
            // sync can help
            const catalogRow = await getCatalogSource().appExists(req.winget_id);
            response.failed++;
            response.results.push({
              winget_id: req.winget_id,
              tenant_id: req.tenant_id,
              success: false,
              error: catalogRow
                ? `No installer data is available for ${req.winget_id} ${updateResult.latest_version} yet - the catalog has not synced this version's manifest. Try again after the next catalog sync.`
                : `${req.winget_id} is not in the app catalog, so a deployment configuration cannot be built for it.`,
            });
            continue;
          }

          const { deploymentConfig, originalUploadHistoryId } = built;

          // Create a policy for this manual trigger
          const { data: newPolicy, error: policyError } = await supabase
            .from('app_update_policies')
            .insert({
              user_id: user.userId,
              tenant_id: req.tenant_id,
              winget_id: req.winget_id,
              policy_type: 'notify',
              deployment_config: deploymentConfig as unknown as Json,
              original_upload_history_id: originalUploadHistoryId,
              is_enabled: true,
            })
            .select()
            .single();

          if (policyError) {
            response.failed++;
            response.results.push({
              winget_id: req.winget_id,
              tenant_id: req.tenant_id,
              success: false,
              error: `Failed to create policy: ${policyError.message}`,
            });
            continue;
          }

          policy = newPolicy;
        }

        // This explicit attempt does not resume the stored automatic policy.
        // Keep the same attempt object through config backfills and dispatch.
        policy.policy_type = 'auto_update';
        policy.is_enabled = true;
        policy.consecutive_failures = 0;

        // Get installer info
        const deploymentConfig = policy.deployment_config as unknown as DeploymentConfig | null;
        const installerResolution = await getLatestInstallerInfo(
          supabase,
          req.winget_id,
          deploymentConfig?.architecture,
          deploymentConfig?.installScope
        );

        if (!installerResolution.ok) {
          response.failed++;
          response.results.push({
            winget_id: req.winget_id,
            tenant_id: req.tenant_id,
            success: false,
            error: installerResolution.failure.message,
          });
          continue;
        }
        const installerInfo = installerResolution.info;

        installerInfo.currentVersion = updateResult.current_version;

        // Look up the most recent upload_history record to get the current
        // Intune app ID. The update_check_results.intune_app_id can be stale
        // if the app was redeployed (forceCreate) since the last update check.
        // Tenant-wide: the newest version of the app in this tenant is the one
        // to supersede and to take assignments from, whichever administrator
        // deployed it. The tenant was proved above.
        const { data: latestUpload } = await supabase
          .from('upload_history')
          .select('intune_app_id')
          .eq('intune_tenant_id', req.tenant_id)
          .eq('winget_id', req.winget_id)
          .order('deployed_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        installerInfo.currentIntuneAppId =
          latestUpload?.intune_app_id || updateResult.intune_app_id;

        // Trigger the update (creates packaging job + history record in DB),
        // one job per deployment track: a Company Portal app and its Update
        // Only companion are both rebuilt, each from its own last deployment.
        // Manual triggers skip rate limits since the user explicitly confirmed
        const triggerResult = await autoUpdateTrigger.triggerTrackedAutoUpdate(
          policy as AppUpdatePolicy,
          installerInfo,
          { skipRateLimits: true, skipPriorDeploymentCheck: true, bypassUpdateScope: true,
            assignmentMigrationOverride: { carryOverAssignments: globalCarryOver, removeAssignmentsFromPreviousApp: false } }
        );

        if (triggerResult.success && triggerResult.jobs.length > 0) {
          // Dispatch the GitHub Actions workflow to actually run the packaging
          const features = getFeatureFlags();
          const isLocalPackagerMode = features.localPackager;


          // One job per deployment track, each dispatched on its own.
          for (const trackJob of triggerResult.jobs) {
            if (!isLocalPackagerMode && isGitHubActionsConfigured()) {
              const appConfig = getAppConfig();
              const baseUrl = appConfig.app.url || (process.env.VERCEL_URL
                ? `https://${process.env.VERCEL_URL}`
                : 'http://localhost:3000');
              const callbackUrl = `${baseUrl}/api/package/callback`;

              const deploymentConfig = trackJob.deploymentConfig;

              // First dispatch and resume must hash the same persisted execution input.
              const { data: job, error: readError } = await supabase.from('packaging_jobs')
                .select('*').eq('id', trackJob.packagingJobId)
                .eq('user_id', user.userId).eq('tenant_id', req.tenant_id)
                .eq('auto_update_policy_id', policy.id).eq('is_auto_update', true)
                .in('status', ['queued', 'awaiting_qa'])
                .is('github_run_id', null).is('callback_run_id', null)
                .is('cancelled_at', null).is('archived_at', null).maybeSingle();
              if (readError || !job) {
                if (readError) {
                  const message = 'Packaging could not start safely. Refresh the deployment status.';
                  const { data: won, error: writeError } = await supabase.from('packaging_jobs')
                    .update({ status: 'failed', error_message: message, completed_at: new Date().toISOString() })
                    .eq('id', trackJob.packagingJobId).eq('user_id', user.userId)
                    .eq('tenant_id', req.tenant_id).eq('auto_update_policy_id', policy.id)
                    .eq('is_auto_update', true).in('status', ['queued', 'awaiting_qa'])
                    .is('github_run_id', null).is('callback_run_id', null)
                    .is('cancelled_at', null).is('archived_at', null).is('error_details', null)
                    .select('id').maybeSingle();
                  if (won && !writeError) {
                    await supabase.from('app_update_policies').update({ last_auto_update_version: null, updated_at: new Date().toISOString() })
                      .eq('id', policy.id).eq('user_id', user.userId).eq('tenant_id', req.tenant_id)
                      .eq('last_auto_update_version', installerInfo.latestVersion);
                    if (trackJob.historyId) {
                      await supabase.from('auto_update_history').update({ status: 'failed',
                        error_message: message, completed_at: new Date().toISOString(),
                      }).eq('id', trackJob.historyId);
                    }
                  }
                }
                response.failed++;
                response.results.push({ winget_id: req.winget_id, tenant_id: req.tenant_id, track: trackJob.track,
                  success: false, packaging_job_id: trackJob.packagingJobId,
                  error: readError ? 'Packaging could not start safely. Refresh the deployment status.'
                    : 'Deployment status changed before packaging could start. Refresh the deployment status.',
                });
                continue;
              }
              const item = storedJobItem(job);
              const workflowInputs = buildStoredJobWorkflowInputs(job, item, {
                callbackUrl, qaOverride: false, sanitizeAssignments: true, descriptionSuffix: appDescriptionSuffix,
              });
              const isBatch = updateRequests.length > 1 || triggerResult.jobs.length > 1;
              const customSource = [deploymentConfig.sourceType, installerInfo.sourceType, item.sourceType].includes('custom');
              let claimedAt: string | null = null;
              const ownedWrite = (patch: Database['public']['Tables']['packaging_jobs']['Update'], afterClaim = false) => {
                let query = supabase.from('packaging_jobs').update(patch)
                  .eq('id', job.id).eq('user_id', user.userId).eq('tenant_id', req.tenant_id)
                  .eq('auto_update_policy_id', policy.id).eq('is_auto_update', true)
                  .eq('status', afterClaim ? 'packaging' : job.status)
                  .is('github_run_id', null).is('callback_run_id', null)
                  .is('cancelled_at', null).is('archived_at', null).is('error_details', null);
                for (const field of ['qa_candidate_id', 'installer_sha256', 'architecture'] as const) {
                  query = job[field] == null ? query.is(field, null) : query.eq(field, job[field]);
                }
                if (afterClaim) query = query.eq('packaging_started_at', claimedAt!);
                else if (job.status === 'awaiting_qa') query = job.qa_resume_due_at == null
                  ? query.is('qa_resume_due_at', null) : query.eq('qa_resume_due_at', job.qa_resume_due_at);
                return query.select('id').maybeSingle();
              };
              try {
                await triggerPackagingWorkflow(workflowInputs, undefined, {
                  skipRunCapture: isBatch,
                  requireQaPass: true,
                  newJobAdmission: !customSource,
                  beforeDispatch: async () => {
                    if (job.status !== 'awaiting_qa') return;
                    const now = new Date().toISOString();
                    const { data: won, error } = await ownedWrite({ status: 'packaging',
                      status_message: 'Installation test passed; packaging started',
                      packaging_started_at: now, qa_completed_at: job.qa_completed_at ?? now });
                    if (error) throw new Error('Could not claim packaging safely. Refresh the deployment status.');
                    if (!won) throw new WorkflowDispatchRetryStopped();
                    claimedAt = now;
                  },
                });
              } catch (error) {
                if (error instanceof WorkflowDispatchRetryStopped) {
                  response.failed++;
                  response.results.push({ winget_id: req.winget_id, tenant_id: req.tenant_id, track: trackJob.track,
                    success: false, packaging_job_id: job.id,
                    error: 'Deployment status changed before packaging could start. Refresh the deployment status.' });
                  continue;
                }
                if (error instanceof WorkflowDispatchUnconfirmedError || error instanceof WorkflowDispatchRateLimitError) {
                  // Only a fresh ownerless admission can be deferred. The resume
                  // path checks the exact payload pin before claiming or posting.
                  const hold = customSource ? null : error instanceof WorkflowDispatchRateLimitError
                    ? error.dispatchIdentity === undefined ? null
                      : dispatchRateLimitHold(error, { [DISPATCH_IDENTITY_KEY]: error.dispatchIdentity })
                    : dispatchRateLimitHold(error, null);
                  const patch: Database['public']['Tables']['packaging_jobs']['Update'] = hold ?? {
                    status: 'failed', error_code: error.code, error_stage: 'authenticate',
                    error_category: 'network', error_message: error.message,
                    completed_at: new Date().toISOString(),
                  };
                  const { data: won, error: writeError } = claimedAt
                    ? await ownedWrite(patch, true)
                    : await supabase.from('packaging_jobs').update(patch)
                      .eq('id', job.id).in('status', hold ? ['queued', 'awaiting_qa'] : ['queued'])
                      .is('github_run_id', null).is('callback_run_id', null)
                      .is('cancelled_at', null).is('archived_at', null).is('error_details', null)
                      .select('id').maybeSingle();
                  if (won && !writeError && hold) {
                    response.triggered++;
                    response.results.push({
                      winget_id: req.winget_id, tenant_id: req.tenant_id, track: trackJob.track,
                      success: true, packaging_job_id: trackJob.packagingJobId,
                      code: error.code,
                    });
                    continue;
                  }
                  if (won && !writeError && trackJob.historyId) {
                    await supabase.from('auto_update_history').update({
                      status: 'failed', error_message: error.message,
                      completed_at: new Date().toISOString(),
                    }).eq('id', trackJob.historyId);
                  }
                  response.failed++;
                  response.results.push({
                    winget_id: req.winget_id, tenant_id: req.tenant_id, track: trackJob.track, success: false,
                    packaging_job_id: trackJob.packagingJobId, code: error.code,
                    error: writeError ? 'Could not schedule the automatic retry. Refresh the deployment status.'
                      : won ? 'Packaging could not start safely. Refresh the deployment status.'
                      : 'Deployment status changed before the retry could be scheduled. Refresh the deployment status.',
                  });
                  continue;
                }
                if (!isQaGateError(error)) {
                  if (claimedAt) {
                    await ownedWrite({ status: 'awaiting_qa', packaging_started_at: null,
                      qa_resume_due_at: new Date(Date.now() + 60_000).toISOString() }, true);
                  }
                  throw error;
                }

                // The status can change between the pre-job auto-update gate and
                // the final dispatch gate. Make that race an explicit safety
                // cancellation rather than leaving a queued/failed mystery job.
                const message = describeQaGateError(error);
                const completedAt = new Date().toISOString();
                const { data: cancelled, error: cancelError } = await ownedWrite({
                    status: 'cancelled',
                    status_message: 'Waiting for the installation test to finish',
                    error_message: message,
                    cancelled_at: completedAt,
                    completed_at: completedAt,
                  });
                if (cancelled && !cancelError && trackJob.historyId) {
                  await supabase
                    .from('auto_update_history')
                    .update({
                      status: 'cancelled',
                      error_message: message,
                      completed_at: completedAt,
                    })
                    .eq('id', trackJob.historyId);
                }

                response.failed++;
                response.results.push({
                  winget_id: req.winget_id,
                  tenant_id: req.tenant_id,
                  track: trackJob.track,
                  success: false,
                  skipped: true,
                  code: error.code,
                  error: cancelled && !cancelError ? message : 'Deployment status changed before packaging could start. Refresh the deployment status.',
                });
                continue;
              }
            }
            // If local packager mode, the job stays in 'queued'/'packaging' for local pickup

            response.triggered++;
            response.results.push({
              winget_id: req.winget_id,
              tenant_id: req.tenant_id,
              track: trackJob.track,
              success: true,
              packaging_job_id: trackJob.packagingJobId,
            });
          }

          if (triggerResult.secondaryTrackError) {
            response.failed++;
            response.results.push({
              winget_id: req.winget_id,
              tenant_id: req.tenant_id,
              track: 'update_only',
              success: false,
              error: `The Update Only app was not updated: ${triggerResult.secondaryTrackError}`,
            });
          }
        } else if (!triggerResult.success) {
          response.failed++;
          response.results.push({
            winget_id: req.winget_id,
            tenant_id: req.tenant_id,
            success: false,
            skipped: triggerResult.skipped || undefined,
            code: triggerResult.code,
            error: triggerResult.error || triggerResult.skipReason || 'Unknown error',
          });
        }
      } catch (error) {
        response.failed++;
        response.results.push({
          winget_id: req.winget_id,
          tenant_id: req.tenant_id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    response.success = response.failed === 0;

    return NextResponse.json(response);
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * Manual update trigger for Supabase-less (SQLite self-hosting) installs.
 *
 * The Supabase path routes through AutoUpdateTrigger, which needs a policy
 * row to carry the deployment config and writes auto_update_history,
 * user_settings and user_profiles alongside. Most of that does not exist here,
 * and a manual trigger does not need it: the user already decided, so there is
 * no rate limit to respect and no automation history to record. What remains
 * is what a normal deployment does - honour the app's policy, resolve the
 * config and the installer, then queue a packaging job for the local packager.
 */
async function triggerWithoutSupabase(
  user: { userId: string; userEmail?: string | null; tenantId: string },
  updateRequests: { winget_id: string; tenant_id: string }[]
): Promise<NextResponse> {
  const db = getDatabase();

  // carryOverAssignments and supersedePreviousApp are user settings, and they
  // decide what happens to the app being replaced: whether its assignments
  // move to the new version and whether Intune records the new app as
  // superseding it. Reading them is not optional - defaulting to false leaves
  // both versions assigned and nothing superseded.
  const storedSettings = await readEffectiveSettings(db, user.userId);
  const globalCarryOver = Boolean(storedSettings.carryOverAssignments);
  const appDescriptionSuffix = resolveAppDescriptionSuffix(
    storedSettings.appDescriptionSuffix
  );
  const supersedePrevious = Boolean(storedSettings.supersedePreviousApp);
  const allowAvailableUninstall = Boolean(storedSettings.allowAvailableUninstall);

  const response: TriggerUpdateResponse = {
    success: true,
    triggered: 0,
    failed: 0,
    results: [],
  };

  // Without a local packager nothing would ever pick the job up, and the
  // GitHub Actions dispatch below needs Supabase-backed policy state, so say
  // so rather than queueing a job that silently never runs.
  const canRunJobs = getFeatureFlags().localPackager;

  for (const req of updateRequests) {
    const fail = (error: string) => {
      response.failed++;
      response.results.push({
        winget_id: req.winget_id,
        tenant_id: req.tenant_id,
        success: false,
        error,
      });
    };

    try {
      if (isSelfUpdatingApp(req.winget_id)) {
        fail(
          `${req.winget_id} keeps itself up to date on the device (Click-to-Run); IntuneGet does not deploy updates for it. Refresh the updates list to remove it.`
        );
        continue;
      }

      if (req.tenant_id !== user.tenantId) {
        fail('Update deployment is only available for the signed-in tenant in SQLite mode.');
        continue;
      }

      if (!canRunJobs) {
        fail(
          'Update deployment needs the local packager on this self-hosted deployment; no packager is configured to run the job.'
        );
        continue;
      }

      const detected = await db.updateCheckResults.getByUserId(user.userId, req.tenant_id);
      const updateResult = detected.find((row) => row.winget_id === req.winget_id);

      if (!updateResult) {
        fail('Update not found');
        continue;
      }

      // Ignore and pin are enforced here, not only in the list the UI offers:
      // a stale page or a direct API call must not be able to deploy a version
      // the operator deliberately held the app back from.
      const [policy] = await db.updatePolicies.getForWingetIds(
        user.userId,
        [req.winget_id],
        req.tenant_id
      );
      if (shouldSkipUpdate(policy as unknown as AppUpdatePolicy, updateResult.latest_version)) {
        fail(
          policy.policy_type === 'ignore'
            ? `Updates for ${req.winget_id} are set to ignore.`
            : `${req.winget_id} is pinned to ${policy.pinned_version}.`
        );
        continue;
      }

      // The detected result's intune_app_id can be stale if the app was
      // redeployed since the last check, so prefer the newest deployment into
      // this tenant - by whichever administrator made it. An app kept as a
      // Company Portal app plus an Update Only app gets one job per track,
      // primary first, each from its own last deployment and Intune app.
      const deployments = await findTrackDeployments(db, req.tenant_id, req.winget_id);
      const targets: Array<{ track?: DeploymentTrack; sourceIntuneAppId: string | null }> =
        deployments.length === 2
          ? deployments
              .filter((deployment) =>
                compareVersions(deployment.uploadHistory.version, updateResult.latest_version) < 0
              )
              .map((deployment) => ({
                track: deployment.track,
                sourceIntuneAppId: deployment.uploadHistory.intune_app_id,
              }))
          : [{
              sourceIntuneAppId:
                (await db.uploadHistory.getByTenantId(req.tenant_id))
                  .find((row) => row.winget_id === req.winget_id)?.intune_app_id ||
                updateResult.intune_app_id ||
                null,
            }];

      for (const target of targets) {
        const built = await buildDeploymentConfigForApp(null, {
          tenantId: req.tenant_id,
          wingetId: req.winget_id,
          latestVersion: updateResult.latest_version,
          track: target.track,
        });

        if (built.status === 'orphaned_job') {
          fail('Could not retrieve deployment configuration');
          // A failed track stops the ones after it, so the Update Only app
          // never moves ahead of the Company Portal app.
          break;
        }

        if (built.status === 'unavailable') {
          const inCatalog = await getCatalogSource().appExists(req.winget_id);
          fail(
            inCatalog
              ? `No installer data is available for ${req.winget_id} ${updateResult.latest_version} yet - the catalog snapshot has not synced this version's manifest. Try again after the next catalog refresh.`
              : `${req.winget_id} is not in the app catalog, so a deployment configuration cannot be built for it.`
          );
          break;
        }

        const config = built.deploymentConfig;
        const installerResolution = await getLatestInstallerInfo(
          null as never,
          req.winget_id,
          config.architecture,
          config.installScope
        );

        if (!installerResolution.ok) {
          fail(installerResolution.failure.message);
          break;
        }
        const installerInfo = installerResolution.info;

        const sourceIntuneAppId = target.sourceIntuneAppId;

        // Supersedence needs something to supersede; without a source app id
        // Intune has no previous version to point at.
        const autoSupersede = supersedePrevious && Boolean(sourceIntuneAppId);

        const job = await db.jobs.create({
          user_id: user.userId,
          user_email: user.userEmail || null,
          tenant_id: req.tenant_id,
          winget_id: req.winget_id,
          version: installerInfo.latestVersion,
          display_name: config.displayName || installerInfo.displayName,
          publisher: config.publisher,
          architecture: config.architecture,
          installer_type: installerInfo.installerType || config.installerType,
          installer_url: installerInfo.installerUrl,
          installer_sha256: installerInfo.installerSha256,
          install_command: config.installCommand,
          uninstall_command: config.uninstallCommand,
          install_scope: config.installScope,
          detection_rules: config.detectionRules as unknown as Json,
          package_config: {
            assignments: normalizeAssignments(config),
            categories: normalizeCategories(config),
            assignedGroups: config.assignedGroups,
            requirementRules: config.requirementRules,
            customRequirementScript: config.customRequirementScript,
            relationships: config.relationships,
            deploymentTrack: classifyDeploymentTrack(config),
            psadtConfig: config.psadtConfig,
            nestedInstallerType: installerInfo.nestedInstallerType,
            nestedInstallerPath: installerInfo.nestedInstallerPath,
            forceCreate: config.forceCreateNewApp !== false,
            sourceIntuneAppId,
            autoSupersede,
            supersedenceType: autoSupersede ? 'update' : undefined,
            allowAvailableUninstall,
            // An explicit per-app choice stored with the original deployment
            // wins; otherwise the user's current global setting applies, read
            // per run rather than frozen. Same precedence as the Supabase path
            // in AutoUpdateTrigger.
            assignmentMigration: config.assignmentMigration ?? {
              carryOverAssignments: globalCarryOver,
              removeAssignmentsFromPreviousApp: globalCarryOver,
            },
            // Composed here, not at dispatch: the local packager reads this
            // field straight out of package_config. The package-id marker is
            // not part of it - the packager writes that to the app's `notes`.
            description: buildIntuneAppDescription({
              description: config.description,
              fallback: config.displayName,
              sourceText: appDescriptionSuffix,
            }),
            notes: config.notes,
          } as unknown as Json,
          status: 'queued',
          progress_percent: 0,
        });

        response.triggered++;
        response.results.push({
          winget_id: req.winget_id,
          tenant_id: req.tenant_id,
          track: target.track,
          success: true,
          packaging_job_id: job.id,
        });
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unknown error');
    }
  }

  response.success = response.failed === 0;
  return NextResponse.json(response);
}
