import { describe, expect, it } from 'vitest';
import {
  DATA_PACKAGE_BASE_PATH,
  dataPackageEndpoints,
  isSafeSegment,
  parseBudgetHeader,
  type BudgetHeader,
} from './config';

const ORIGIN = 'https://app.example.test';

describe('data-package config: endpoints', () => {
  it('builds every endpoint under the fixed admin base path', () => {
    const e = dataPackageEndpoints(ORIGIN);
    expect(e.jobs).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs`);
    expect(e.job('job-1')).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs/job-1`);
    expect(e.heartbeat('job-1')).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs/job-1/heartbeat`);
    expect(e.resume('job-1')).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs/job-1/resume`);
    expect(e.complete('job-1')).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs/job-1/complete`);
    expect(e.abort('job-1')).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs/job-1/abort`);
    expect(e.tables('job-1')).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs/job-1/tables`);
    expect(e.rows('job-1', 'inspections')).toBe(`${ORIGIN}${DATA_PACKAGE_BASE_PATH}/jobs/job-1/tables/inspections/rows`);
  });

  it('refuses unsafe path segments instead of encoding them into a URL', () => {
    expect(isSafeSegment('inspections')).toBe(true);
    expect(isSafeSegment('job-abc_123')).toBe(true);
    for (const bad of ['../x', 'a/b', 'a b', 'a?b', 'a#b', '', '.', '..', 'a\\b', 'é']) {
      expect(isSafeSegment(bad)).toBe(false);
    }
    const e = dataPackageEndpoints(ORIGIN);
    expect(() => e.job('../evil')).toThrow();
    expect(() => e.rows('job-1', 'a/b')).toThrow();
  });

  it('rejects an origin with a path, query, credentials or non-http scheme', () => {
    for (const bad of [`${ORIGIN}/path`, `${ORIGIN}?x=1`, 'https://u:p@app.example.test', 'ftp://app.example.test', 'not a url']) {
      expect(() => dataPackageEndpoints(bad)).toThrow();
    }
  });
});

describe('data-package config: X-Dp-Budget header', () => {
  it('parses the measurement-only header emitted by E-1', () => {
    const parsed = parseBudgetHeader('reads=0/0;writes=0/0;profile=worker-free;pageRows=48;pageBytes=98304');
    expect(parsed).toEqual<BudgetHeader>({
      reads: '0/0', writes: '0/0', profile: 'worker-free', pageRows: 48, pageBytes: 98304,
    });
    expect(parseBudgetHeader('reads=0/0;writes=0/0;profile=worker-paid;pageRows=1000;pageBytes=4194304')?.profile).toBe('worker-paid');
  });

  it('is tolerant of spacing and member order', () => {
    const parsed = parseBudgetHeader(' pageBytes=100 ; profile=worker-free ; pageRows=7;reads=1/2;writes=3/4 ');
    expect(parsed?.pageRows).toBe(7);
    expect(parsed?.pageBytes).toBe(100);
    expect(parsed?.reads).toBe('1/2');
  });

  it('returns null on missing, malformed or non-positive ceilings', () => {
    expect(parseBudgetHeader(null)).toBeNull();
    expect(parseBudgetHeader('')).toBeNull();
    expect(parseBudgetHeader('garbage')).toBeNull();
    expect(parseBudgetHeader('profile=worker-free;pageRows=0;pageBytes=10')).toBeNull();
    expect(parseBudgetHeader('profile=other;pageRows=10;pageBytes=10')).toBeNull();
    expect(parseBudgetHeader('profile=worker-free;pageRows=NaN;pageBytes=10')).toBeNull();
    expect(parseBudgetHeader('reads=0/0;reads=1/1;writes=0/0;profile=worker-free;pageRows=10;pageBytes=10')).toBeNull();
  });
});
