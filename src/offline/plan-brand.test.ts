import { describe, expect, it } from 'vitest';
import { isIssuedPlan, issuePlan, markIssued } from './plan-brand';

describe('issuePlan freezes the whole plan', () => {
  it('descends into an inner object even when the outer one was already frozen', () => {
    const inner = { list: ['a'], deeper: { n: 1 } };
    const plan = issuePlan(Object.freeze({ inner }));
    expect(Object.isFrozen(plan.inner)).toBe(true);
    expect(Object.isFrozen(inner.list)).toBe(true);
    expect(Object.isFrozen(inner.deeper)).toBe(true);
    expect(() => inner.list.push('b')).toThrow(TypeError);
  });

  it('a cycle does not loop forever, and everything on it is frozen', () => {
    const a: { self?: object; b: { back?: object } } = { b: {} };
    a.self = a;
    a.b.back = a;
    issuePlan(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.b)).toBe(true);
  });

  it('control: an ordinary nested plan is frozen throughout and is issued', () => {
    const plan = issuePlan({ a: { b: { c: [1] } } });
    expect(Object.isFrozen(plan.a.b.c)).toBe(true);
    expect(isIssuedPlan(plan)).toBe(true);
  });

  it('markIssued registers without freezing, and a copy is not issued', () => {
    const plan = markIssued({ x: { y: 1 } });
    expect(Object.isFrozen(plan.x)).toBe(false);
    expect(isIssuedPlan({ ...plan })).toBe(false);
  });
});
