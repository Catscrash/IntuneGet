/**
 * Database Types for IntuneGet
 * Shared interfaces between SQLite and Supabase implementations
 */

import type { Json } from '@/types/database';
import type {
  AppUpdatePolicy,
  AutoUpdateHistory,
  AutoUpdateHistoryWithPolicy,
  AutoUpdateStatus,
} from '@/types/update-policies';

/**
 * Query options for auto-update history reads.
 */
export interface AutoUpdateHistoryQuery {
  tenantId?: string;
  wingetId?: string;
  status?: AutoUpdateStatus;
  limit: number;
  offset: number;
}

/**
 * A detected available update for a deployed app.
 */
export interface UpdateCheckResult {
  id: string;
  user_id: string;
  tenant_id: string;
  winget_id: string;
  intune_app_id: string;
  display_name: string;
  current_version: string;
  latest_version: string;
  is_critical: boolean;
  is_managed: boolean;
  large_icon_type: string | null;
  large_icon_value: string | null;
  notified_at: string | null;
  dismissed_at: string | null;
  detected_at: string;
  updated_at: string;
}

export interface UpdateCheckQuery {
  tenantId?: string;
  includeDismissed?: boolean;
  criticalOnly?: boolean;
}

/**
 * Packaging job record
 */
export interface PackagingJob {
  id: string;
  user_id: string;
  user_email: string | null;
  tenant_id: string | null;
  winget_id: string;
  version: string;
  display_name: string;
  publisher: string | null;
  architecture: string | null;
  installer_type: string | null;
  installer_url: string | null;
  installer_sha256: string | null;
  install_command: string | null;
  uninstall_command: string | null;
  install_scope: string | null;
  silent_switches: string | null;
  detection_rules: Json | null;
  package_config: Json | null;
  github_run_id: string | null;
  github_run_url: string | null;
  intunewin_url: string | null;
  intunewin_size_bytes: number | null;
  unencrypted_content_size: number | null;
  encryption_info: Json | null;
  intune_app_id: string | null;
  intune_app_url: string | null;
  app_source: string | null;
  status: string;
  status_message: string | null;
  progress_percent: number;
  progress_message: string | null;
  error_message: string | null;
  error_stage: string | null;
  error_category: string | null;
  error_code: string | null;
  error_details: Json | null;
  warnings: Json | null;
  execution_profile_sha256: string | null;
  presentation_profile_sha256: string | null;
  qa_candidate_id: string | null;
  qa_requested_at: string | null;
  qa_completed_at: string | null;
  qa_resume_due_at?: string;
  is_auto_update?: boolean | null;
  auto_update_policy_id?: string | null;
  packager_id: string | null;
  packager_heartbeat_at: string | null;
  /** Build identity the packager reported when it claimed the job. */
  packager_build: string | null;
  claimed_at: string | null;
  packaging_started_at: string | null;
  packaging_completed_at: string | null;
  upload_started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A tenant's acceptance of a publisher licence agreement required by a
 * curated application. Unique per tenant, agreement, and agreement version.
 */
export interface CuratedLicenceAttestationRecord {
  id: string;
  tenant_id: string;
  app_id: string;
  attestation_id: string;
  attestation_version: string;
  accepted_by_user_id: string;
  accepted_by_email: string | null;
  accepted_at: string;
}

export type CuratedLicenceAttestationInput = Omit<CuratedLicenceAttestationRecord, 'id' | 'accepted_at'>;

export type ClaimedAppStatus = 'pending' | 'deploying' | 'deployed' | 'failed';

/**
 * A discovered app a user claimed for deployment, one per tenant and app
 */
export interface ClaimedAppRecord {
  id: string;
  user_id: string;
  tenant_id: string;
  discovered_app_id: string;
  discovered_app_name: string;
  winget_package_id: string;
  intune_app_id: string | null;
  device_count_at_claim: number | null;
  claimed_at: string;
  status: ClaimedAppStatus;
}

export type ClaimedAppInput = Pick<
  ClaimedAppRecord,
  'user_id' | 'tenant_id' | 'discovered_app_id' | 'discovered_app_name' | 'winget_package_id' | 'device_count_at_claim'
>;

/**
 * Upload history record
 */
export interface UploadHistoryRecord {
  id: string;
  packaging_job_id: string | null;
  user_id: string;
  winget_id: string;
  version: string;
  display_name: string;
  publisher: string | null;
  intune_app_id: string;
  intune_app_url: string | null;
  intune_tenant_id: string | null;
  app_source: string | null;
  deployed_at: string;
}

/**
 * A user's outbound webhook.
 *
 * Mirrors webhook_configurations (supabase/migrations/011). Only the storage
 * lived in Supabase - formatting, HMAC signing and delivery in
 * lib/webhooks/service.ts are plain logic, so a self-hosted install can use
 * webhooks once the configurations have somewhere to live.
 *
 * headers is stored as JSON in both backends and returned parsed.
 */
export interface WebhookConfigurationRecord {
  id: string;
  user_id: string;
  name: string;
  url: string;
  webhook_type: 'slack' | 'teams' | 'discord' | 'custom';
  /** HMAC secret; null when the operator did not set one. */
  secret: string | null;
  headers: Record<string, string>;
  is_enabled: boolean;
  /** Circuit-breaker state, owned by the delivery path. */
  failure_count: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Per-app update policy. One shape for both backends; deployment_config is
 * stored as JSON and returned parsed, so callers never have to know which
 * backend answered.
 */
export type UpdatePolicyRecord = AppUpdatePolicy;

/**
 * Per-user settings blob.
 *
 * Mirrors the user_settings table (supabase/migrations/020). A single JSON
 * object per user; the app treats unknown keys as pass-through, so the shape
 * is deliberately open.
 */
export interface UserSettingsRecord {
  user_id: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Job statistics
 */
export type AnalyticsJob = Pick<PackagingJob, 'id' | 'user_id' | 'user_email' | 'status' | 'completed_at' | 'created_at' | 'winget_id' | 'display_name' | 'intune_app_url'>;
export type AnalyticsJobScope = { userId: string; tenantId?: never } | { tenantId: string; userId?: never };

export interface JobStats {
  queued: number;
  packaging: number;
  uploading: number;
  deployed: number;
  failed: number;
  cancelled: number;
}

/**
 * Database adapter interface
 * Both SQLite and Supabase implementations must conform to this interface
 */
/** A packager that has recently worked, and the build it reported. */
export interface ActivePackager {
  packager_id: string;
  packager_build: string | null;
  last_seen_at: string;
}

/** A user together with a tenant they are active in. */
export interface UserTenantPair {
  user_id: string;
  tenant_id: string;
}

export interface DatabaseAdapter {
  jobs: {
    /**
     * Get jobs by status
     */
    getByStatus(status: string, limit?: number, ascending?: boolean): Promise<PackagingJob[]>;

    /**
     * Get a job by ID
     */
    getById(id: string): Promise<PackagingJob | null>;

    /**
     * Get jobs by user ID
     */
    getByUserId(userId: string, limit?: number): Promise<PackagingJob[]>;

    /**
     * Every job belonging to a user, newest first and uncapped.
     *
     * For aggregate statistics, where a page would silently undercount rather
     * than merely shorten the answer. Use getByUserId() for list views.
     */
    getAllByUserId(userId: string): Promise<PackagingJob[]>;

    /**
     * Get jobs for every user in a tenant (tenant-wide deployments view)
     */
    getByTenantId(tenantId: string, limit?: number): Promise<PackagingJob[]>;

    /** Failed and cancelled approval checkpoints include dismissed jobs and every user/version in the tenant. */
    getApprovalFailures(tenantId: string, wingetId: string,
      cursor?: { createdAt: string; id: string }): Promise<PackagingJob[]>;

    /** Complete summary input, independent of the uploads page limit. */
    getAnalyticsJobs(scope: AnalyticsJobScope): Promise<AnalyticsJob[]>;

    /**
     * Get every job in a tenant that reached a given status. Filters on the
     * status in the query rather than in the caller, so a tenant with more
     * jobs than any page size still yields a complete set - callers use this
     * to decide whether an app is already deployed, where a missing row reads
     * as "not deployed" rather than as a truncated list.
     */
    getByTenantIdAndStatus(tenantId: string, status: string): Promise<PackagingJob[]>;

    /**
     * Create a new job
     */
    create(job: Partial<PackagingJob>): Promise<PackagingJob>;

    /**
     * Update a job
     * @param id Job ID
     * @param data Fields to update
     * @param conditions Optional conditions for the update (e.g., { status: 'queued' })
     */
    update(id: string, data: Partial<PackagingJob>, conditions?: Record<string, unknown>): Promise<PackagingJob | null>;

    /**
     * Claim a job atomically (only if status is 'queued')
     */
    claim(
      jobId: string,
      packagerId: string,
      packagerBuild?: string | null
    ): Promise<PackagingJob | null>;

    /**
     * Packagers that have checked in since the given time, newest heartbeat
     * first, with the build each last reported.
     *
     * There is no packager registry - a packager only ever makes itself known
     * by working - so the jobs are the register. Reported so an operator can
     * see which build is live without logging into the machine it runs on.
     */
    listActivePackagers(since: Date): Promise<ActivePackager[]>;

    /**
     * Release a job back to queued state
     */
    release(jobId: string, packagerId: string): Promise<PackagingJob | null>;

    /**
     * Force release a stale job back to queued state after confirming it is still stale
     */
    forceRelease(jobId: string, staleThreshold?: Date): Promise<PackagingJob | null>;

    /**
     * Get stale jobs (packaging status with old heartbeat)
     */
    getStaleJobs(staleThreshold: Date): Promise<PackagingJob[]>;

    /**
     * Get job statistics
     */
    getStats(): Promise<JobStats>;

    /**
     * Soft-archive a single job by ID
     */
    deleteById(id: string): Promise<boolean>;

    /**
     * Bulk-archive jobs matching a user ID and a set of statuses
     * Returns the number of archived rows
     */
    deleteByUserIdAndStatuses(userId: string, statuses: string[]): Promise<number>;
  };

  uploadHistory: {
    /**
     * Create an upload history record
     */
    create(record: Partial<UploadHistoryRecord>): Promise<UploadHistoryRecord>;

    /**
     * Get upload history by user ID
     */
    getByUserId(userId: string, limit?: number): Promise<UploadHistoryRecord[]>;

    /**
     * Get the newest deployment of one app for a user in a tenant, filtered in
     * the query rather than a fixed window so old deployments are found.
     */
    getLatest(userId: string, tenantId: string, wingetId: string): Promise<UploadHistoryRecord | null>;

    /**
     * Every recorded deployment, newest first. Used by the update check to scan
     * the whole local fleet without knowing the user ids up front.
     */
    listAll(limit?: number): Promise<UploadHistoryRecord[]>;

    /**
     * Get a user's upload history within one tenant. Filters on the tenant in
     * the query rather than in the caller, so a user active in several
     * tenants cannot have this tenant's rows pushed out by another tenant's.
     */
    getByUserIdAndTenantId(userId: string, tenantId: string): Promise<UploadHistoryRecord[]>;

    /**
     * Every deployment into one tenant, whoever made it.
     *
     * A tenant is usually worked by several administrators, and an app one of
     * them deployed is still an IntuneGet app to all of them. Provenance
     * questions - "is this app ours", "what config did it go out with" - must
     * therefore be asked of the tenant, not of the signed-in user; asking per
     * user makes a colleague's app look foreign and loses its configuration on
     * the next update. Callers must have proved the user may act on the tenant
     * before calling (a row existing is not permission to read it).
     */
    getByTenantId(tenantId: string): Promise<UploadHistoryRecord[]>;

    /**
     * Every distinct user/tenant pair that has ever deployed. The scheduled
     * refresh needs to know whose update rows to rebuild, and there is no
     * session to ask - a deployment is what makes a user interested in a
     * tenant's updates.
     */
    listUserTenants(): Promise<UserTenantPair[]>;
  };

  userSettings: {
    /**
     * A user's settings object, or null if they never saved any.
     */
    get(userId: string): Promise<Record<string, unknown> | null>;

    /**
     * Merge a partial settings object into the stored one and return the
     * result. Callers send only the keys they are changing, so this must
     * merge rather than replace.
     */
    merge(
      userId: string,
      partial: Record<string, unknown>
    ): Promise<Record<string, unknown>>;
  };

  updateCheckResults: {
    /**
     * List detected updates for a user with the optional filters.
     */
    list(userId: string, query: UpdateCheckQuery): Promise<UpdateCheckResult[]>;

    /**
     * Insert or refresh a detected update on the
     * (user_id, tenant_id, winget_id, intune_app_id) key.
     */
    upsert(
      record: Partial<UpdateCheckResult> &
        Pick<
          UpdateCheckResult,
          'user_id' | 'tenant_id' | 'winget_id' | 'intune_app_id' | 'display_name' | 'current_version' | 'latest_version'
        >
    ): Promise<UpdateCheckResult>;

    /**
     * Dismiss or restore detected updates owned by the user. Returns the rows changed.
     */
    setDismissed(ids: string[], userId: string, dismissedAt: string | null): Promise<number>;

    /**
     * Delete detected updates for a user and tenant that are no longer current.
     */
    deleteMissing(
      userId: string,
      tenantId: string,
      keep: Array<{ wingetId: string; intuneAppId: string }>
    ): Promise<number>;

    /**
     * Every detected update for a user, newest first. tenantId narrows to one
     * tenant; omit it for all tenants the user has results in.
     */
    getByUserId(userId: string, tenantId?: string | null): Promise<UpdateCheckResult[]>;

    /**
     * Every distinct user/tenant pair that already has update rows. Together
     * with the deployment pairs this is who the scheduled refresh serves:
     * rows exist for anyone who has ever looked, including admins who only
     * update apps a colleague deployed.
     */
    listUserTenants(): Promise<UserTenantPair[]>;

    /**
     * Replace a tenant's results for this user with a freshly detected set.
     *
     * A refresh re-derives every row from a live scan, so rows that are gone
     * from the scan must disappear rather than linger as phantom updates -
     * hence replace rather than merge. Callers carry notified_at forward
     * themselves, since only they know whether the version changed.
     */
    replaceForUserAndTenant(
      userId: string,
      tenantId: string,
      rows: Array<Partial<UpdateCheckResult>>
    ): Promise<UpdateCheckResult[]>;

    /**
     * Mark one detected update dismissed (or un-dismissed with null), scoped
     * to the owning user so one user cannot dismiss another's row.
     */
    setDismissedAt(
      id: string,
      userId: string,
      dismissedAt: string | null
    ): Promise<UpdateCheckResult | null>;

    /**
     * Stamp notified_at on a set of detected updates, so the next run does not
     * notify about them again. Scoped to the owning user like the dismissal
     * above. Returns how many rows were stamped.
     */
    setNotifiedAt(ids: string[], userId: string, notifiedAt: string): Promise<number>;
  };

  updatePolicies: {
    /**
     * List every policy for a user, newest first, optionally scoped to a tenant
     */
    list(userId: string, tenantId?: string): Promise<AppUpdatePolicy[]>;

    /**
     * Get one policy owned by the user
     */
    getById(id: string, userId: string): Promise<AppUpdatePolicy | null>;

    /**
     * Get the policy for a user, tenant, and app (the unique key)
     */
    getByKey(userId: string, tenantId: string, wingetId: string): Promise<AppUpdatePolicy | null>;

    /**
     * Every policy, newest first. Used by the update check across the local fleet.
     */
    listAll(): Promise<AppUpdatePolicy[]>;

    /**
     * Insert or replace a policy on the (user_id, tenant_id, winget_id) key
     */
    upsert(
      policy: Partial<AppUpdatePolicy> &
        Pick<AppUpdatePolicy, 'user_id' | 'tenant_id' | 'winget_id' | 'policy_type'>
    ): Promise<AppUpdatePolicy>;

    /**
     * Update a policy owned by the user. Returns null when no row matched.
     */
    update(id: string, userId: string, data: Partial<AppUpdatePolicy>): Promise<AppUpdatePolicy | null>;

    /**
     * Delete a policy owned by the user. Returns false when no row matched.
     */
    delete(id: string, userId: string): Promise<boolean>;

    /**
     * The policies covering a set of packages, for annotating a list of
     * detected updates. Filters in the query rather than in the caller: a
     * missing policy reads as "no policy", so a truncated page would silently
     * un-ignore an app rather than merely shorten the answer.
     */
    getForWingetIds(
      userId: string,
      wingetIds: string[],
      tenantId?: string | null
    ): Promise<UpdatePolicyRecord[]>;
  };

  webhooks: {
    /** A user's webhooks, newest first. */
    getByUserId(userId: string): Promise<WebhookConfigurationRecord[]>;

    /**
     * Only the ones that should receive a delivery. Filtered in the query
     * rather than in the caller: a disabled webhook must never be delivered
     * to, and that is not a decision to leave to each call site.
     */
    getEnabledByUserId(userId: string): Promise<WebhookConfigurationRecord[]>;

    /** One webhook, scoped to its owner. */
    getById(id: string, userId: string): Promise<WebhookConfigurationRecord | null>;

    /** How many a user already has, for the per-user limit. */
    countByUserId(userId: string): Promise<number>;

    create(
      webhook: Pick<
        WebhookConfigurationRecord,
        'user_id' | 'name' | 'url' | 'webhook_type' | 'secret' | 'headers' | 'is_enabled'
      >
    ): Promise<WebhookConfigurationRecord>;

    /**
     * Patch a webhook, scoped to its owner. Returns null when no row of
     * theirs has this id.
     */
    update(
      id: string,
      userId: string,
      data: Partial<Omit<WebhookConfigurationRecord, 'id' | 'user_id' | 'created_at'>>
    ): Promise<WebhookConfigurationRecord | null>;

    deleteById(id: string, userId: string): Promise<boolean>;
  };

  autoUpdateHistory: {
    /**
     * Create an auto-update history record
     */
    create(
      record: Partial<AutoUpdateHistory> &
        Pick<AutoUpdateHistory, 'policy_id' | 'from_version' | 'to_version' | 'update_type'>
    ): Promise<AutoUpdateHistory>;

    /**
     * Update a history record. Returns null when no row matched.
     */
    update(id: string, data: Partial<AutoUpdateHistory>): Promise<AutoUpdateHistory | null>;

    /**
     * List a user's history with the policy target and deployed app name,
     * newest first, honoring the optional filters and pagination.
     */
    list(userId: string, query: AutoUpdateHistoryQuery): Promise<AutoUpdateHistoryWithPolicy[]>;

    /**
     * Count history records for the given policies triggered at or after
     * `since`, optionally filtered by status. Backs the auto-update rate limits.
     */
    countForPolicies(policyIds: string[], since: string, status?: AutoUpdateStatus): Promise<number>;
  };

  curatedLicenceAttestations: {
    /**
     * Get a tenant's acceptance of one exact agreement version
     */
    get(tenantId: string, attestationId: string, attestationVersion: string): Promise<CuratedLicenceAttestationRecord | null>;

    /**
     * Every agreement acceptance recorded for a tenant, newest first
     */
    listByTenant(tenantId: string): Promise<CuratedLicenceAttestationRecord[]>;

    /**
     * Record an acceptance. Idempotent: an existing acceptance of the same
     * agreement version is returned unchanged.
     */
    accept(record: CuratedLicenceAttestationInput): Promise<CuratedLicenceAttestationRecord>;
  };

  claimedApps: {
    /**
     * Record a claim. Claiming an app again in the same tenant resets the
     * existing claim to pending for the new claimant.
     */
    upsert(claim: ClaimedAppInput): Promise<ClaimedAppRecord>;

    /**
     * Every claim recorded for a tenant, newest first
     */
    listByTenant(tenantId: string): Promise<ClaimedAppRecord[]>;

    /**
     * Update a claim in the tenant. Returns null when no row matched.
     */
    update(
      id: string,
      tenantId: string,
      data: Partial<Pick<ClaimedAppRecord, 'status' | 'intune_app_id'>>
    ): Promise<ClaimedAppRecord | null>;
  };
}
