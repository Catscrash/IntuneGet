import { describe, it, expect, vi } from 'vitest';
import type { DatabaseAdapter } from '@/lib/db/types';
import {
  classifyDeploymentTrack,
  findTrackDeployments,
} from '@/lib/update-policies/deployment-tracks';

describe('classifyDeploymentTrack', () => {
  it.each([
    [{ assignments: [{ type: 'allUsers', intent: 'available' }] }, 'primary'],
    [{ assignments: [{ type: 'allDevices', intent: 'updateOnly' }] }, 'update_only'],
    [{ assignedGroups: [{ groupId: 'g', assignmentType: 'updateOnly' }] }, 'update_only'],
    [{ deploymentTrack: 'primary', assignments: [{ type: 'allDevices', intent: 'updateOnly' }] }, 'primary'],
    [{ deploymentTrack: 'update_only' }, 'update_only'],
    [null, 'primary'],
    [{ deploymentTrack: 'other' }, 'primary'],
  ])('classifies %j as %s', (config, track) => {
    expect(classifyDeploymentTrack(config)).toBe(track);
  });
});

describe('findTrackDeployments', () => {
  function adapter(rows: Array<{ id: string; winget_id: string; packaging_job_id: string | null }>, jobs: Record<string, unknown>) {
    const getById = vi.fn(async (id: string) => jobs[id] ?? null);
    const db = {
      uploadHistory: { getByTenantId: vi.fn(async () => rows) },
      jobs: { getById },
    } as unknown as DatabaseAdapter;
    return { db, getById };
  }

  it('returns the newest deployment of each track, primary first', async () => {
    const { db } = adapter(
      [
        { id: 'u3', winget_id: 'App', packaging_job_id: 'update-2' },
        { id: 'other', winget_id: 'Other', packaging_job_id: 'other' },
        { id: 'p2', winget_id: 'App', packaging_job_id: 'portal-2' },
        { id: 'u1', winget_id: 'App', packaging_job_id: 'update-1' },
        { id: 'p1', winget_id: 'App', packaging_job_id: 'portal-1' },
      ],
      {
        'update-2': { package_config: { assignments: [{ type: 'allDevices', intent: 'updateOnly' }] } },
        'portal-2': { package_config: { assignments: [{ type: 'allUsers', intent: 'available' }] } },
      }
    );

    const deployments = await findTrackDeployments(db, 'tenant', 'App');

    expect(deployments.map((deployment) => [deployment.track, deployment.uploadHistory.id])).toEqual([
      ['primary', 'p2'],
      ['update_only', 'u3'],
    ]);
  });

  it('stops reading jobs once both tracks are found', async () => {
    const { db, getById } = adapter(
      [
        { id: 'u2', winget_id: 'App', packaging_job_id: 'update' },
        { id: 'p2', winget_id: 'App', packaging_job_id: 'portal' },
        { id: 'p1', winget_id: 'App', packaging_job_id: 'portal' },
      ],
      {
        update: { package_config: { deploymentTrack: 'update_only' } },
        portal: { package_config: {} },
      }
    );

    await findTrackDeployments(db, 'tenant', 'App');

    expect(getById).toHaveBeenCalledTimes(2);
  });
});
