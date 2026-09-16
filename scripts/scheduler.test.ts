import { describe, it, expect } from 'vitest';
import { parseJobs } from './scheduler.mjs';

describe('parseJobs', () => {
  it('parses a list of path/interval pairs', () => {
    expect(parseJobs('/api/cron/refresh-updates:21600,/api/cron/x:60')).toEqual([
      { path: '/api/cron/refresh-updates', seconds: 21600 },
      { path: '/api/cron/x', seconds: 60 },
    ]);
  });

  it('tolerates whitespace and trailing separators', () => {
    expect(parseJobs(' /a:60 , ,')).toEqual([{ path: '/a', seconds: 60 }]);
  });

  it('rejects a job that would hammer the endpoint', () => {
    // A typo turning hours into seconds would otherwise call a full Graph scan
    // in a tight loop.
    expect(() => parseJobs('/a:5')).toThrow(/seconds >= 30/);
  });

  it('rejects entries that are not a path and a number', () => {
    expect(() => parseJobs('api/cron/x:60')).toThrow();
    expect(() => parseJobs('/a:soon')).toThrow();
    expect(() => parseJobs('/a')).toThrow();
  });
});
