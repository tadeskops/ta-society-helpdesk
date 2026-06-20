import { describe, it, expect } from 'vitest';
import { str, optStr, oneOf, num, optNum, bool, optBool, normalisePhone } from '../src/lib/validate.ts';
import { BadRequest } from '../src/lib/errors.ts';

describe('validate.str', () => {
  it('trims and enforces min/max', () => {
    expect(str('  hello  ', 'x')).toBe('hello');
    expect(() => str('a', 'x', { min: 2 })).toThrow(BadRequest);
    expect(() => str('abcd', 'x', { max: 3 })).toThrow(BadRequest);
  });
  it('rejects non-string', () => {
    expect(() => str(42, 'x')).toThrow(BadRequest);
    expect(() => str(null, 'x')).toThrow(BadRequest);
  });
});

describe('validate.optStr', () => {
  it('returns undefined for empty / null / undefined', () => {
    expect(optStr(undefined, 'x')).toBeUndefined();
    expect(optStr('', 'x')).toBeUndefined();
    expect(optStr(null, 'x')).toBeUndefined();
  });
  it('validates when present', () => {
    expect(() => optStr('x'.repeat(10), 'x', { max: 5 })).toThrow(BadRequest);
  });
});

describe('validate.oneOf', () => {
  it('accepts allowed values', () => {
    expect(oneOf('a', 'x', ['a', 'b'] as const)).toBe('a');
  });
  it('rejects others', () => {
    expect(() => oneOf('c', 'x', ['a', 'b'] as const)).toThrow(BadRequest);
  });
});

describe('validate.num / optNum / bool / optBool', () => {
  it('num enforces finite + bounds', () => {
    expect(num(5, 'x', { min: 0, max: 10 })).toBe(5);
    expect(() => num(NaN, 'x')).toThrow(BadRequest);
    expect(() => num(-1, 'x', { min: 0 })).toThrow(BadRequest);
    expect(() => num('5' as any, 'x')).toThrow(BadRequest);
  });
  it('optNum passes through undefined', () => {
    expect(optNum(undefined, 'x')).toBeUndefined();
    expect(optNum(7, 'x', { min: 0 })).toBe(7);
  });
  it('bool / optBool', () => {
    expect(bool(true, 'x')).toBe(true);
    expect(() => bool('true' as any, 'x')).toThrow(BadRequest);
    expect(optBool(undefined, 'x')).toBeUndefined();
  });
});

describe('normalisePhone', () => {
  it('returns +91-prefixed when 10 digits', () => {
    expect(normalisePhone('98765 43210')).toBe('+919876543210');
    expect(normalisePhone('(987) 654-3210')).toBe('+919876543210');
  });
  it('keeps + when 11+ digits', () => {
    expect(normalisePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('returns empty for too-short', () => {
    expect(normalisePhone('123')).toBe('');
  });
});
