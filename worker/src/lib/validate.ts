// Minimal input validators. Each helper either returns a clean value
// or throws BadRequest. Keep messages caller-friendly — they go back
// to the page in the response envelope.

import { BadRequest } from './errors.ts';

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown, field: string, opts: { min?: number; max?: number } = {}): string => {
  if (typeof v !== 'string') throw new BadRequest(`${field} must be a string`);
  const s = v.trim();
  if (opts.min !== undefined && s.length < opts.min) throw new BadRequest(`${field} must be at least ${opts.min} chars`);
  if (opts.max !== undefined && s.length > opts.max) throw new BadRequest(`${field} must be at most ${opts.max} chars`);
  return s;
};

export const optStr = (v: unknown, field: string, opts: { max?: number } = {}): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  return str(v, field, opts);
};

export const oneOf = <T extends string>(v: unknown, field: string, allowed: readonly T[]): T => {
  const s = str(v, field);
  if (!allowed.includes(s as T)) throw new BadRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return s as T;
};

export const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== 'boolean') throw new BadRequest(`${field} must be true or false`);
  return v;
};

export const optBool = (v: unknown, field: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  return bool(v, field);
};

export const num = (v: unknown, field: string, opts: { min?: number; max?: number } = {}): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest(`${field} must be a number`);
  if (opts.min !== undefined && v < opts.min) throw new BadRequest(`${field} must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new BadRequest(`${field} must be <= ${opts.max}`);
  return v;
};

export const optNum = (v: unknown, field: string, opts: { min?: number; max?: number } = {}): number | undefined => {
  if (v === undefined || v === null) return undefined;
  return num(v, field, opts);
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const email = (v: unknown, field: string): string => {
  const s = str(v, field).toLowerCase();
  if (!EMAIL_RE.test(s)) throw new BadRequest(`${field} is not a valid email`);
  return s;
};

const PHONE_DIGITS_RE = /\D+/g;
export const normalisePhone = (v: string): string => {
  const digits = v.replace(PHONE_DIGITS_RE, '');
  if (digits.length < 10) return ''; // treat as no phone
  return digits.length === 10 ? `+91${digits}` : `+${digits}`;
};

export const parseJson = async <T = unknown>(req: Request): Promise<T> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequest('Body is not valid JSON');
  }
  if (!isObj(body)) throw new BadRequest('Body must be a JSON object');
  return body as T;
};
