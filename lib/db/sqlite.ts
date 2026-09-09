/**
 * SQLite Database Implementation for Self-Hosted Mode
 * Provides a simple, zero-dependency database for true self-hosting
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  DatabaseAdapter,
  PackagingJob,
  UpdateCheckResult,
  UpdatePolicyRecord,
  UploadHistoryRecord,
  WebhookConfigurationRecord,
} from './types';

// Singleton database instance
let db: Database.Database | null = null;

/**
 * Get or create the SQLite database instance
 */
function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/intuneget.db';
  const dbDir = path.dirname(dbPath);

  // Ensure the data directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Initialize schema
  initializeSchema(db);

  return db;
}

/**
 * Initialize the database schema
 */
function initializeSchema(db: Database.Database): void {
  // Create packaging_jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS packaging_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT,
      tenant_id TEXT,
      winget_id TEXT NOT NULL,
      version TEXT NOT NULL,
      display_name TEXT NOT NULL,
      publisher TEXT,
      architecture TEXT,
      installer_type TEXT NOT NULL,
      installer_url TEXT NOT NULL,
      installer_sha256 TEXT,
      install_command TEXT,
      uninstall_command TEXT,
      install_scope TEXT,
      silent_switches TEXT,
      detection_rules TEXT,
      package_config TEXT,
      github_run_id TEXT,
      github_run_url TEXT,
      intunewin_url TEXT,
      intunewin_size_bytes INTEGER,
      unencrypted_content_size INTEGER,
      encryption_info TEXT,
      intune_app_id TEXT,
      intune_app_url TEXT,
      app_source TEXT DEFAULT 'win32',
      status TEXT NOT NULL DEFAULT 'queued',
      status_message TEXT,
      progress_percent INTEGER DEFAULT 0,
      progress_message TEXT,
      error_message TEXT,
      error_stage TEXT,
      error_category TEXT,
      error_code TEXT,
      error_details TEXT,
      warnings TEXT,
      execution_profile_sha256 TEXT,
      presentation_profile_sha256 TEXT,
      qa_candidate_id TEXT,
      qa_requested_at TEXT,
      qa_completed_at TEXT,
      packager_id TEXT,
      packager_heartbeat_at TEXT,
      claimed_at TEXT,
      packaging_started_at TEXT,
      packaging_completed_at TEXT,
      upload_started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const existingColumns = new Set(
    (db.pragma('table_info(packaging_jobs)') as Array<{ name: string }>).map((column) => column.name),
  );
  const compatibleColumns: Record<string, string> = {
    app_source: "TEXT DEFAULT 'win32'",
    error_stage: 'TEXT',
    error_category: 'TEXT',
    error_code: 'TEXT',
    error_details: 'TEXT',
    warnings: 'TEXT',
    archived_at: 'TEXT',
    execution_profile_sha256: 'TEXT',
    presentation_profile_sha256: 'TEXT',
    qa_candidate_id: 'TEXT',
    qa_requested_at: 'TEXT',
    qa_completed_at: 'TEXT',
  };
  for (const [column, definition] of Object.entries(compatibleColumns)) {
    if (!existingColumns.has(column)) {
      db.exec(`ALTER TABLE packaging_jobs ADD COLUMN ${column} ${definition}`);
    }
  }

  // Create index for status queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_status ON packaging_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_user_id ON packaging_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_created_at ON packaging_jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_packaging_jobs_packager_heartbeat ON packaging_jobs(packager_heartbeat_at);
  `);

  // Create upload_history table
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_history (
      id TEXT PRIMARY KEY,
      packaging_job_id TEXT,
      user_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      version TEXT NOT NULL,
      display_name TEXT NOT NULL,
      publisher TEXT,
      intune_app_id TEXT NOT NULL,
      intune_app_url TEXT,
      intune_tenant_id TEXT,
      deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (packaging_job_id) REFERENCES packaging_jobs(id)
    )
  `);

  // Create index for upload_history
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_upload_history_user_id ON upload_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_upload_history_deployed_at ON upload_history(deployed_at);
  `);

  // Cache of detected app updates. Mirrors the update_check_results table in
  // supabase/migrations (011, 018, 031), including its uniqueness rule: one
  // row per user, tenant, package and Intune app object.
  db.exec(`
    CREATE TABLE IF NOT EXISTS update_check_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      intune_app_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      current_version TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      is_critical INTEGER NOT NULL DEFAULT 0,
      is_managed INTEGER NOT NULL DEFAULT 1,
      large_icon_type TEXT,
      large_icon_value TEXT,
      notified_at TEXT,
      dismissed_at TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tenant_id, winget_id, intune_app_id)
    )
  `);

  // Per-user settings blob. Mirrors user_settings in supabase/migrations/020.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Outbound webhooks. Mirrors webhook_configurations in
  // supabase/migrations/011. Delivery itself needs no database, so storing
  // these is all that stood between a self-hosted install and working
  // webhooks.
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_configurations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      webhook_type TEXT NOT NULL
        CHECK (webhook_type IN ('slack', 'teams', 'discord', 'custom')),
      secret TEXT,
      headers TEXT NOT NULL DEFAULT '{}',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      last_success_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_configurations_user ON webhook_configurations(user_id);
  `);

  // Per-app update policies. Mirrors app_update_policies in
  // supabase/migrations/012, including its uniqueness rule: one policy per
  // user, tenant and package. original_upload_history_id is deliberately not a
  // foreign key here - the Supabase table sets it null when the referenced
  // upload is deleted, and a plain column reproduces that without needing
  // SQLite foreign keys enabled.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_update_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      winget_id TEXT NOT NULL,
      policy_type TEXT NOT NULL DEFAULT 'notify'
        CHECK (policy_type IN ('auto_update', 'notify', 'ignore', 'pin_version')),
      pinned_version TEXT,
      deployment_config TEXT,
      original_upload_history_id TEXT,
      last_auto_update_at TEXT,
      last_auto_update_version TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tenant_id, winget_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_app_update_policies_user ON app_update_policies(user_id);
    CREATE INDEX IF NOT EXISTS idx_app_update_policies_user_tenant ON app_update_policies(user_id, tenant_id);
    CREATE INDEX IF NOT EXISTS idx_app_update_policies_winget ON app_update_policies(winget_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_update_check_results_user ON update_check_results(user_id);
    CREATE INDEX IF NOT EXISTS idx_update_check_results_tenant ON update_check_results(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_update_check_results_detected ON update_check_results(detected_at DESC);
  `);
}

/**
 * SQLite has no boolean type and stores these as 0/1; the adapter contract
 * hands callers real booleans.
 */
function parseUpdateCheckRow(row: Record<string, unknown>): UpdateCheckResult {
  return {
    ...row,
    is_critical: Boolean(row.is_critical),
    is_managed: Boolean(row.is_managed),
  } as UpdateCheckResult;
}

function parseWebhookRow(row: Record<string, unknown>): WebhookConfigurationRecord {
  let headers: Record<string, string> = {};
  if (row.headers) {
    try {
      headers = JSON.parse(row.headers as string) as Record<string, string>;
    } catch {
      // A malformed blob must not take down the whole webhook list; an empty
      // header set still delivers.
      headers = {};
    }
  }
  return {
    ...row,
    headers,
    is_enabled: Boolean(row.is_enabled),
    failure_count: Number(row.failure_count ?? 0),
  } as WebhookConfigurationRecord;
}

function parsePolicyRow(row: Record<string, unknown>): UpdatePolicyRecord {
  return {
    ...row,
    deployment_config: row.deployment_config
      ? (JSON.parse(row.deployment_config as string) as Record<string, unknown>)
      : null,
    is_enabled: Boolean(row.is_enabled),
    consecutive_failures: Number(row.consecutive_failures ?? 0),
  } as UpdatePolicyRecord;
}

/**
 * Parse JSON fields from database row
 */
function parseJobRow(row: Record<string, unknown>): PackagingJob {
  return {
    ...row,
    detection_rules: row.detection_rules ? JSON.parse(row.detection_rules as string) : null,
    package_config: row.package_config ? JSON.parse(row.package_config as string) : null,
    encryption_info: row.encryption_info ? JSON.parse(row.encryption_info as string) : null,
    error_details: row.error_details ? JSON.parse(row.error_details as string) : null,
    warnings: row.warnings ? JSON.parse(row.warnings as string) : null,
  } as PackagingJob;
}

/**
 * SQLite implementation of the database adapter
 */
export const sqliteDb: DatabaseAdapter = {
  jobs: {
    /**
     * Get jobs by status
     */
    async getByStatus(status: string, limit: number = 10, ascending: boolean = true): Promise<PackagingJob[]> {
      const database = getDb();
      const order = ascending ? 'ASC' : 'DESC';
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE status = ? AND archived_at IS NULL
        ORDER BY created_at ${order}
        LIMIT ?
      `);
      const rows = stmt.all(status, limit) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    /**
     * Get a job by ID
     */
    async getById(id: string): Promise<PackagingJob | null> {
      const database = getDb();
      const stmt = database.prepare('SELECT * FROM packaging_jobs WHERE id = ?');
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      return row ? parseJobRow(row) : null;
    },

    /**
     * Get jobs by user ID
     * Auto-excludes terminal-state jobs older than 7 days
     */
    async getByUserId(userId: string, limit: number = 50): Promise<PackagingJob[]> {
      const database = getDb();
      // Return the most recent jobs for the user with no age cutoff, so the
      // Uploads (all activities) view shows older completed deployments too.
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE user_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(userId, limit) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    async getAllByUserId(userId: string): Promise<PackagingJob[]> {
      const database = getDb();
      // No LIMIT: callers aggregate over the full set, where a page would
      // undercount rather than just shorten the answer.
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE user_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC
      `);
      const rows = stmt.all(userId) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    async getByTenantId(tenantId: string, limit: number = 50): Promise<PackagingJob[]> {
      const database = getDb();
      // Every user's jobs in this tenant, most recent first, no age cutoff.
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE tenant_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(tenantId, limit) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    async getByTenantIdAndStatus(tenantId: string, status: string): Promise<PackagingJob[]> {
      const database = getDb();
      // No LIMIT: the caller needs the complete set to answer "is this app
      // already deployed in the tenant", where a missing row is meaningful.
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE tenant_id = ? AND status = ? AND archived_at IS NULL
        ORDER BY created_at DESC
      `);
      const rows = stmt.all(tenantId, status) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    /**
     * Create a new job
     */
    async create(job: Partial<PackagingJob>): Promise<PackagingJob> {
      const database = getDb();
      const id = job.id || crypto.randomUUID();
      const now = new Date().toISOString();

      const stmt = database.prepare(`
        INSERT INTO packaging_jobs (
          id, user_id, user_email, tenant_id, winget_id, version, display_name,
          publisher, architecture, installer_type, installer_url, installer_sha256,
          install_command, uninstall_command, install_scope, detection_rules,
          package_config, app_source, status, status_message, progress_percent,
          error_stage, error_category, error_code, execution_profile_sha256,
          presentation_profile_sha256, qa_candidate_id, qa_requested_at,
          qa_completed_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);

      stmt.run(
        id,
        job.user_id,
        job.user_email || null,
        job.tenant_id || null,
        job.winget_id,
        job.version,
        job.display_name,
        job.publisher || null,
        job.architecture || null,
        job.installer_type,
        job.installer_url,
        job.installer_sha256 || null,
        job.install_command || null,
        job.uninstall_command || null,
        job.install_scope || null,
        job.detection_rules ? JSON.stringify(job.detection_rules) : null,
        job.package_config ? JSON.stringify(job.package_config) : null,
        job.app_source || 'win32',
        job.status || 'queued',
        job.status_message || null,
        job.progress_percent || 0,
        job.error_stage || null,
        job.error_category || null,
        job.error_code || null,
        job.execution_profile_sha256 || null,
        job.presentation_profile_sha256 || null,
        job.qa_candidate_id || null,
        job.qa_requested_at || null,
        job.qa_completed_at || null,
        now,
        now
      );

      return this.getById(id) as Promise<PackagingJob>;
    },

    /**
     * Update a job
     */
    async update(id: string, data: Partial<PackagingJob>, conditions?: Record<string, unknown>): Promise<PackagingJob | null> {
      const database = getDb();
      const now = new Date().toISOString();

      // Build the SET clause
      const updates: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      for (const [key, value] of Object.entries(data)) {
        if (key === 'detection_rules' || key === 'package_config' || key === 'encryption_info' || key === 'warnings' || key === 'error_details') {
          updates.push(`${key} = ?`);
          values.push(value ? JSON.stringify(value) : null);
        } else {
          updates.push(`${key} = ?`);
          values.push(value);
        }
      }

      // Build the WHERE clause
      let whereClause = 'id = ?';
      values.push(id);

      if (conditions) {
        for (const [key, value] of Object.entries(conditions)) {
          if (value === null) {
            whereClause += ` AND ${key} IS NULL`;
          } else {
            whereClause += ` AND ${key} = ?`;
            values.push(value);
          }
        }
      }

      const stmt = database.prepare(`
        UPDATE packaging_jobs
        SET ${updates.join(', ')}
        WHERE ${whereClause}
      `);

      const result = stmt.run(...values);

      // Check if the update was successful
      if (result.changes === 0) {
        return null;
      }

      return this.getById(id);
    },

    /**
     * Claim a job atomically (only if status is 'queued')
     */
    async claim(jobId: string, packagerId: string): Promise<PackagingJob | null> {
      const now = new Date().toISOString();

      return this.update(
        jobId,
        {
          status: 'packaging',
          packager_id: packagerId,
          packager_heartbeat_at: now,
          claimed_at: now,
          packaging_started_at: now,
        },
        { status: 'queued' }
      );
    },

    /**
     * Release a job back to queued state
     */
    async release(jobId: string, packagerId: string): Promise<PackagingJob | null> {
      return this.update(
        jobId,
        {
          status: 'queued',
          packager_id: null,
          packager_heartbeat_at: null,
          claimed_at: null,
          packaging_started_at: null,
        },
        { packager_id: packagerId }
      );
    },

    /**
     * Force release a stale job back to queued state (no packager_id check)
     */
    async forceRelease(jobId: string): Promise<PackagingJob | null> {
      const database = getDb();
      const stmt = database.prepare(`
        UPDATE packaging_jobs
        SET status = 'queued',
            packager_id = NULL,
            packager_heartbeat_at = NULL,
            claimed_at = NULL,
            packaging_started_at = NULL,
            updated_at = ?
        WHERE id = ?
      `);

      const result = stmt.run(new Date().toISOString(), jobId);

      if (result.changes === 0) {
        return null;
      }

      return this.getById(jobId);
    },

    /**
     * Get stale jobs (packaging status with old heartbeat)
     */
    async getStaleJobs(staleThreshold: Date): Promise<PackagingJob[]> {
      const database = getDb();
      const stmt = database.prepare(`
        SELECT * FROM packaging_jobs
        WHERE status = 'packaging'
        AND packager_heartbeat_at < ?
      `);
      const rows = stmt.all(staleThreshold.toISOString()) as Record<string, unknown>[];
      return rows.map(parseJobRow);
    },

    /**
     * Get job statistics
     */
    async getStats(): Promise<{
      queued: number;
      packaging: number;
      uploading: number;
      deployed: number;
      failed: number;
      cancelled: number;
    }> {
      const database = getDb();
      const stmt = database.prepare(`
        SELECT status, COUNT(*) as count
        FROM packaging_jobs
        WHERE archived_at IS NULL
        GROUP BY status
      `);
      const rows = stmt.all() as Array<{ status: string; count: number }>;

      const stats = {
        queued: 0,
        packaging: 0,
        uploading: 0,
        deployed: 0,
        failed: 0,
        cancelled: 0,
      };

      for (const row of rows) {
        if (row.status in stats) {
          stats[row.status as keyof typeof stats] = row.count;
        }
      }

      return stats;
    },

    /** Soft-archive a single job by ID. */
    async deleteById(id: string): Promise<boolean> {
      const database = getDb();
      const now = new Date().toISOString();
      const stmt = database.prepare(
        'UPDATE packaging_jobs SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
      );
      const result = stmt.run(now, now, id);
      return result.changes > 0;
    },

    /** Bulk-archive jobs matching a user ID and a set of statuses. */
    async deleteByUserIdAndStatuses(userId: string, statuses: string[]): Promise<number> {
      const database = getDb();
      const placeholders = statuses.map(() => '?').join(', ');
      const stmt = database.prepare(`
        UPDATE packaging_jobs
        SET archived_at = ?, updated_at = ?
        WHERE user_id = ? AND status IN (${placeholders}) AND archived_at IS NULL
      `);
      const now = new Date().toISOString();
      const result = stmt.run(now, now, userId, ...statuses);
      return result.changes;
    },
  },

  uploadHistory: {
    /**
     * Create an upload history record
     */
    async create(record: Partial<UploadHistoryRecord>): Promise<UploadHistoryRecord> {
      const database = getDb();
      const id = record.id || crypto.randomUUID();
      const now = new Date().toISOString();

      const stmt = database.prepare(`
        INSERT INTO upload_history (
          id, packaging_job_id, user_id, winget_id, version, display_name,
          publisher, intune_app_id, intune_app_url, intune_tenant_id, deployed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        record.packaging_job_id || null,
        record.user_id,
        record.winget_id,
        record.version,
        record.display_name,
        record.publisher || null,
        record.intune_app_id,
        record.intune_app_url || null,
        record.intune_tenant_id || null,
        record.deployed_at || now
      );

      const result = database.prepare('SELECT * FROM upload_history WHERE id = ?').get(id);
      return result as UploadHistoryRecord;
    },

    /**
     * Get upload history by user ID
     */
    async getByUserId(userId: string, limit: number = 50): Promise<UploadHistoryRecord[]> {
      const database = getDb();
      const stmt = database.prepare(`
        SELECT * FROM upload_history
        WHERE user_id = ?
        ORDER BY deployed_at DESC
        LIMIT ?
      `);
      return stmt.all(userId, limit) as UploadHistoryRecord[];
    },

    /**
     * Get a user's upload history within one tenant
     */
    async getByUserIdAndTenantId(
      userId: string,
      tenantId: string
    ): Promise<UploadHistoryRecord[]> {
      const database = getDb();
      // No LIMIT: the caller needs the complete set to answer "did this user
      // already deploy this app", where a missing row is meaningful.
      const stmt = database.prepare(`
        SELECT * FROM upload_history
        WHERE user_id = ? AND intune_tenant_id = ?
        ORDER BY deployed_at DESC
      `);
      return stmt.all(userId, tenantId) as UploadHistoryRecord[];
    },
  },

  userSettings: {
    async get(userId: string): Promise<Record<string, unknown> | null> {
      const database = getDb();
      const row = database
        .prepare('SELECT settings FROM user_settings WHERE user_id = ?')
        .get(userId) as { settings: string } | undefined;

      if (!row) {
        return null;
      }

      try {
        return JSON.parse(row.settings) as Record<string, unknown>;
      } catch {
        return null;
      }
    },

    async merge(
      userId: string,
      partial: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      const database = getDb();
      const now = new Date().toISOString();

      // Read and write in one transaction so two concurrent saves cannot each
      // merge onto the same stale base and lose one another's keys.
      const mergeSettings = database.transaction(() => {
        const row = database
          .prepare('SELECT settings FROM user_settings WHERE user_id = ?')
          .get(userId) as { settings: string } | undefined;

        let current: Record<string, unknown> = {};
        if (row) {
          try {
            current = JSON.parse(row.settings) as Record<string, unknown>;
          } catch {
            current = {};
          }
        }

        const merged = { ...current, ...partial };
        database
          .prepare(
            `INSERT INTO user_settings (user_id, settings, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`
          )
          .run(userId, JSON.stringify(merged), now, now);
        return merged;
      });

      return mergeSettings();
    },
  },

  updateCheckResults: {
    async getByUserId(userId: string, tenantId?: string | null): Promise<UpdateCheckResult[]> {
      const database = getDb();
      const stmt = tenantId
        ? database.prepare(`
            SELECT * FROM update_check_results
            WHERE user_id = ? AND tenant_id = ?
            ORDER BY detected_at DESC
          `)
        : database.prepare(`
            SELECT * FROM update_check_results
            WHERE user_id = ?
            ORDER BY detected_at DESC
          `);
      const rows = (
        tenantId ? stmt.all(userId, tenantId) : stmt.all(userId)
      ) as Record<string, unknown>[];
      return rows.map(parseUpdateCheckRow);
    },

    async replaceForUserAndTenant(
      userId: string,
      tenantId: string,
      rows: Array<Partial<UpdateCheckResult>>
    ): Promise<UpdateCheckResult[]> {
      const database = getDb();
      const now = new Date().toISOString();

      const deleteStmt = database.prepare(
        'DELETE FROM update_check_results WHERE user_id = ? AND tenant_id = ?'
      );
      const insertStmt = database.prepare(`
        INSERT INTO update_check_results (
          id, user_id, tenant_id, winget_id, intune_app_id, display_name,
          current_version, latest_version, is_critical, is_managed,
          large_icon_type, large_icon_value, notified_at, dismissed_at,
          detected_at, updated_at
        ) VALUES (
          @id, @user_id, @tenant_id, @winget_id, @intune_app_id, @display_name,
          @current_version, @latest_version, @is_critical, @is_managed,
          @large_icon_type, @large_icon_value, @notified_at, @dismissed_at,
          @detected_at, @updated_at
        )
      `);

      // Delete and insert must not be observable apart: a reader between them
      // would see the tenant as having no updates at all.
      const replaceAll = database.transaction((incoming: Array<Partial<UpdateCheckResult>>) => {
        deleteStmt.run(userId, tenantId);
        for (const row of incoming) {
          insertStmt.run({
            id: row.id || crypto.randomUUID(),
            user_id: userId,
            tenant_id: tenantId,
            winget_id: row.winget_id,
            intune_app_id: row.intune_app_id,
            display_name: row.display_name,
            current_version: row.current_version,
            latest_version: row.latest_version,
            is_critical: row.is_critical ? 1 : 0,
            is_managed: row.is_managed === false ? 0 : 1,
            large_icon_type: row.large_icon_type ?? null,
            large_icon_value: row.large_icon_value ?? null,
            notified_at: row.notified_at ?? null,
            dismissed_at: row.dismissed_at ?? null,
            detected_at: row.detected_at || now,
            updated_at: now,
          });
        }
      });

      replaceAll(rows);
      return this.getByUserId(userId, tenantId);
    },

    async setDismissedAt(
      id: string,
      userId: string,
      dismissedAt: string | null
    ): Promise<UpdateCheckResult | null> {
      const database = getDb();
      const stmt = database.prepare(`
        UPDATE update_check_results
        SET dismissed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `);
      const result = stmt.run(dismissedAt, new Date().toISOString(), id, userId);

      if (result.changes === 0) {
        return null;
      }

      const row = database
        .prepare('SELECT * FROM update_check_results WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      return row ? parseUpdateCheckRow(row) : null;
    },

    async setNotifiedAt(
      ids: string[],
      userId: string,
      notifiedAt: string
    ): Promise<number> {
      if (ids.length === 0) return 0;
      const database = getDb();
      const stmt = database.prepare(
        'UPDATE update_check_results SET notified_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
      );
      const now = new Date().toISOString();
      // One transaction: a partial stamp would notify about the rest twice.
      const stampAll = database.transaction((rows: string[]) => {
        let changed = 0;
        for (const id of rows) {
          changed += stmt.run(notifiedAt, now, id, userId).changes;
        }
        return changed;
      });
      return stampAll(ids);
    },
  },

  updatePolicies: {
    async getByUserId(userId: string, tenantId?: string | null): Promise<UpdatePolicyRecord[]> {
      const database = getDb();
      const rows = (
        tenantId
          ? database
              .prepare(
                `SELECT * FROM app_update_policies
                 WHERE user_id = ? AND tenant_id = ?
                 ORDER BY updated_at DESC`
              )
              .all(userId, tenantId)
          : database
              .prepare(
                `SELECT * FROM app_update_policies
                 WHERE user_id = ?
                 ORDER BY updated_at DESC`
              )
              .all(userId)
      ) as Record<string, unknown>[];
      return rows.map(parsePolicyRow);
    },

    async getById(id: string, userId: string): Promise<UpdatePolicyRecord | null> {
      const row = getDb()
        .prepare('SELECT * FROM app_update_policies WHERE id = ? AND user_id = ?')
        .get(id, userId) as Record<string, unknown> | undefined;
      return row ? parsePolicyRow(row) : null;
    },

    async getForWingetIds(
      userId: string,
      wingetIds: string[],
      tenantId?: string | null
    ): Promise<UpdatePolicyRecord[]> {
      if (wingetIds.length === 0) return [];
      const database = getDb();
      const placeholders = wingetIds.map(() => '?').join(', ');
      const rows = (
        tenantId
          ? database
              .prepare(
                `SELECT * FROM app_update_policies
                 WHERE user_id = ? AND tenant_id = ? AND winget_id IN (${placeholders})`
              )
              .all(userId, tenantId, ...wingetIds)
          : database
              .prepare(
                `SELECT * FROM app_update_policies
                 WHERE user_id = ? AND winget_id IN (${placeholders})`
              )
              .all(userId, ...wingetIds)
      ) as Record<string, unknown>[];
      return rows.map(parsePolicyRow);
    },

    async upsert(
      policy: Parameters<DatabaseAdapter['updatePolicies']['upsert']>[0]
    ): Promise<{ policy: UpdatePolicyRecord; created: boolean }> {
      const database = getDb();
      const now = new Date().toISOString();

      // Look up and write in one transaction: two concurrent saves for the
      // same app would otherwise both see no row and race on the insert, and
      // the `created` flag the caller reports back would be wrong for one.
      const save = database.transaction(() => {
        const existing = database
          .prepare(
            `SELECT id, created_at FROM app_update_policies
             WHERE user_id = ? AND tenant_id = ? AND winget_id = ?`
          )
          .get(policy.user_id, policy.tenant_id, policy.winget_id) as
          | { id: string; created_at: string }
          | undefined;

        const id = existing?.id || crypto.randomUUID();
        database
          .prepare(
            `INSERT INTO app_update_policies (
               id, user_id, tenant_id, winget_id, policy_type, pinned_version,
               deployment_config, original_upload_history_id, last_auto_update_at,
               last_auto_update_version, is_enabled, consecutive_failures,
               created_at, updated_at
             ) VALUES (
               @id, @user_id, @tenant_id, @winget_id, @policy_type, @pinned_version,
               @deployment_config, @original_upload_history_id, @last_auto_update_at,
               @last_auto_update_version, @is_enabled, @consecutive_failures,
               @created_at, @updated_at
             )
             ON CONFLICT(user_id, tenant_id, winget_id) DO UPDATE SET
               policy_type = excluded.policy_type,
               pinned_version = excluded.pinned_version,
               deployment_config = excluded.deployment_config,
               original_upload_history_id = excluded.original_upload_history_id,
               is_enabled = excluded.is_enabled,
               updated_at = excluded.updated_at`
          )
          .run({
            id,
            user_id: policy.user_id,
            tenant_id: policy.tenant_id,
            winget_id: policy.winget_id,
            policy_type: policy.policy_type,
            pinned_version: policy.pinned_version ?? null,
            deployment_config: policy.deployment_config
              ? JSON.stringify(policy.deployment_config)
              : null,
            original_upload_history_id: policy.original_upload_history_id ?? null,
            // Only ever the insert's values: the ON CONFLICT branch above
            // leaves these three alone so an existing row keeps its history.
            last_auto_update_at: null,
            last_auto_update_version: null,
            consecutive_failures: 0,
            is_enabled: policy.is_enabled === false ? 0 : 1,
            created_at: existing?.created_at || now,
            updated_at: now,
          });

        const row = database
          .prepare('SELECT * FROM app_update_policies WHERE id = ?')
          .get(id) as Record<string, unknown>;
        return { policy: parsePolicyRow(row), created: !existing };
      });

      return save();
    },

    async update(
      id: string,
      userId: string,
      data: Partial<Omit<UpdatePolicyRecord, 'id' | 'user_id' | 'created_at'>>
    ): Promise<UpdatePolicyRecord | null> {
      const database = getDb();
      const assignments: string[] = [];
      const values: unknown[] = [];

      const columns: Array<[keyof typeof data, (value: unknown) => unknown]> = [
        ['tenant_id', (v) => v],
        ['winget_id', (v) => v],
        ['policy_type', (v) => v],
        ['pinned_version', (v) => v ?? null],
        ['deployment_config', (v) => (v ? JSON.stringify(v) : null)],
        ['original_upload_history_id', (v) => v ?? null],
        ['last_auto_update_at', (v) => v ?? null],
        ['last_auto_update_version', (v) => v ?? null],
        ['is_enabled', (v) => (v === false ? 0 : 1)],
        ['consecutive_failures', (v) => Number(v ?? 0)],
      ];

      for (const [column, encode] of columns) {
        // `in` alone would treat an explicit `undefined` as a value and, for
        // is_enabled, coerce it to true - silently re-enabling a policy.
        if (data[column] !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(encode(data[column]));
        }
      }

      if (assignments.length === 0) {
        return this.getById(id, userId);
      }

      assignments.push('updated_at = ?');
      values.push(new Date().toISOString());

      const result = database
        .prepare(
          `UPDATE app_update_policies SET ${assignments.join(', ')}
           WHERE id = ? AND user_id = ?`
        )
        .run(...values, id, userId);

      return result.changes === 0 ? null : this.getById(id, userId);
    },

    async deleteById(id: string, userId: string): Promise<boolean> {
      const result = getDb()
        .prepare('DELETE FROM app_update_policies WHERE id = ? AND user_id = ?')
        .run(id, userId);
      return result.changes > 0;
    },
  },

  webhooks: {
    async getByUserId(userId: string): Promise<WebhookConfigurationRecord[]> {
      const rows = getDb()
        .prepare(
          `SELECT * FROM webhook_configurations
           WHERE user_id = ?
           ORDER BY created_at DESC`
        )
        .all(userId) as Record<string, unknown>[];
      return rows.map(parseWebhookRow);
    },

    async getEnabledByUserId(userId: string): Promise<WebhookConfigurationRecord[]> {
      const rows = getDb()
        .prepare(
          `SELECT * FROM webhook_configurations
           WHERE user_id = ? AND is_enabled = 1
           ORDER BY created_at DESC`
        )
        .all(userId) as Record<string, unknown>[];
      return rows.map(parseWebhookRow);
    },

    async getById(id: string, userId: string): Promise<WebhookConfigurationRecord | null> {
      const row = getDb()
        .prepare('SELECT * FROM webhook_configurations WHERE id = ? AND user_id = ?')
        .get(id, userId) as Record<string, unknown> | undefined;
      return row ? parseWebhookRow(row) : null;
    },

    async countByUserId(userId: string): Promise<number> {
      const row = getDb()
        .prepare('SELECT COUNT(*) AS count FROM webhook_configurations WHERE user_id = ?')
        .get(userId) as { count: number };
      return Number(row?.count ?? 0);
    },

    async create(
      webhook: Parameters<DatabaseAdapter['webhooks']['create']>[0]
    ): Promise<WebhookConfigurationRecord> {
      const database = getDb();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      database
        .prepare(
          `INSERT INTO webhook_configurations (
             id, user_id, name, url, webhook_type, secret, headers,
             is_enabled, failure_count, last_failure_at, last_success_at,
             created_at, updated_at
           ) VALUES (
             @id, @user_id, @name, @url, @webhook_type, @secret, @headers,
             @is_enabled, 0, NULL, NULL, @created_at, @updated_at
           )`
        )
        .run({
          id,
          user_id: webhook.user_id,
          name: webhook.name,
          url: webhook.url,
          webhook_type: webhook.webhook_type,
          secret: webhook.secret ?? null,
          headers: JSON.stringify(webhook.headers ?? {}),
          is_enabled: webhook.is_enabled === false ? 0 : 1,
          created_at: now,
          updated_at: now,
        });

      const row = database
        .prepare('SELECT * FROM webhook_configurations WHERE id = ?')
        .get(id) as Record<string, unknown>;
      return parseWebhookRow(row);
    },

    async update(
      id: string,
      userId: string,
      data: Partial<Omit<WebhookConfigurationRecord, 'id' | 'user_id' | 'created_at'>>
    ): Promise<WebhookConfigurationRecord | null> {
      const database = getDb();
      const assignments: string[] = [];
      const values: unknown[] = [];

      const columns: Array<[keyof typeof data, (value: unknown) => unknown]> = [
        ['name', (v) => v],
        ['url', (v) => v],
        ['webhook_type', (v) => v],
        ['secret', (v) => v ?? null],
        ['headers', (v) => JSON.stringify(v ?? {})],
        ['is_enabled', (v) => (v === false ? 0 : 1)],
        ['failure_count', (v) => Number(v ?? 0)],
        ['last_failure_at', (v) => v ?? null],
        ['last_success_at', (v) => v ?? null],
      ];

      for (const [column, encode] of columns) {
        // An explicit undefined means "not given", not "clear it".
        if (data[column] !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(encode(data[column]));
        }
      }

      if (assignments.length === 0) {
        return this.getById(id, userId);
      }

      assignments.push('updated_at = ?');
      values.push(new Date().toISOString());

      const result = database
        .prepare(
          `UPDATE webhook_configurations SET ${assignments.join(', ')}
           WHERE id = ? AND user_id = ?`
        )
        .run(...values, id, userId);

      return result.changes === 0 ? null : this.getById(id, userId);
    },

    async deleteById(id: string, userId: string): Promise<boolean> {
      const result = getDb()
        .prepare('DELETE FROM webhook_configurations WHERE id = ? AND user_id = ?')
        .run(id, userId);
      return result.changes > 0;
    },
  },
};

/**
 * Close the database connection (for cleanup)
 */
export function closeSqliteDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
