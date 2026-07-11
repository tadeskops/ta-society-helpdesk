// GET  /access-lists           — committee + admin (read)
// PUT  /access-lists/:role     — admin (write); one-admin-min guard
// Spec: tsh_requirement.md §2 (one-admin-min), §5.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson } from '../lib/validate.ts';
import { BadRequest, Conflict } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { invalidateCache } from '../config/loader.ts';

const PATHS: Record<string, string> = {
  managers:  'config/managers.json',
  committee: 'config/committee.json',
  admins:    'config/admins.json',
  // Additive capability tags for confidential Treasury access.
  // See worker/src/auth/roles.ts → canViewTreasuryLedger.
  treasurer: 'config/treasurer.json',
  chairman:  'config/chairman.json',
  secretary: 'config/secretary.json',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normaliseList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) throw new BadRequest('emails must be an array of strings');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') throw new BadRequest('each email must be a string');
    const e = v.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) throw new BadRequest(`invalid email: ${v}`);
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
};

export const mountAccess = (r: Router): void => {
  // ---- GET /access-lists ----
  r.get('/access-lists', (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['COMMITTEE', 'ADMIN'], requireIdentity: true });
    return ok(ctx.env, ctx.req, ctx.access);
  });

  // ---- PUT /access-lists/:role ----
  r.put('/access-lists/:role', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, { roles: ['ADMIN'], requireIdentity: true });
    const role = params['role'];
    if (!role || !(role in PATHS)) throw new BadRequest(`unknown role: ${role}`);
    const path = PATHS[role]!;
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const next = normaliseList(body['emails']);

    // One-admin-minimum guard — never let the admin list go empty,
    // and never allow the caller to remove themselves from it. The
    // second clause prevents an admin from accidentally locking
    // themselves out via the Settings UI.
    if (role === 'admins') {
      if (next.length === 0) throw new Conflict('Admin list cannot be empty');
      if (!next.includes(ctx.identity!.email)) {
        throw new Conflict('You cannot remove yourself from the admin list');
      }
    }

    const actor = ctx.identity!.email;
    const existing = await getFile(ctx.env, path);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(
      ctx.env,
      path,
      serialised,
      `access: update ${role} list by ${actor}`,
      actor,
      existing?.sha,
    );
    await writeAudit(ctx.env, {
      actor,
      action: 'access-list:put',
      target: path,
      detail: `count=${next.length}`,
    });
    invalidateCache();
    return ok(ctx.env, ctx.req, { saved: true, count: next.length });
  });
};
