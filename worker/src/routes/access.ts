// GET  /access-lists           — anyone at COMMITTEE-or-above may read
// PUT  /access-lists/:role     — delegated: caller's primary tier must
//                                 be STRICTLY ABOVE the target role in
//                                 the 8-tier hierarchy (Admin edits
//                                 admins itself). One-admin-min guard
//                                 applies. Spec: tsh_requirement.md §2.
//
// Delegation examples (see worker/src/auth/roles.ts → canEditAccessList):
//   ADMIN     → may PUT admins, chairman, secretary, treasurer,
//               committee, contributor, managers
//   CHAIRMAN  → may PUT secretary, treasurer, committee, contributor, managers
//   SECRETARY → may PUT treasurer, committee, contributor, managers
//   TREASURER → may PUT committee, contributor, managers
//   COMMITTEE → may PUT contributor, managers
//   CONTRIBUTOR → may PUT managers
//   MANAGER/RESIDENT → 403

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson } from '../lib/validate.ts';
import { BadRequest, Conflict, Forbidden } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { invalidateCache } from '../config/loader.ts';
import { canEditAccessList, type EditableAccessRole } from '../auth/roles.ts';

const PATHS: Record<EditableAccessRole, string> = {
  admins:      'config/admins.json',
  chairman:    'config/chairman.json',
  secretary:   'config/secretary.json',
  treasurer:   'config/treasurer.json',
  committee:   'config/committee.json',
  contributor: 'config/contributor.json',
  managers:    'config/managers.json',
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
  // Anyone at COMMITTEE-or-above may read the full snapshot (needed by
  // the Settings page to render the delegation UI). Below-committee
  // tiers get 403; they wouldn't be able to edit anything anyway.
  r.get('/access-lists', (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['COMMITTEE', 'TREASURER', 'SECRETARY', 'CHAIRMAN', 'ADMIN'], requireIdentity: true });
    return ok(ctx.env, ctx.req, ctx.access);
  });

  // ---- PUT /access-lists/:role ----
  r.put('/access-lists/:role', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, { requireIdentity: true });
    const role = params['role'];
    if (!role || !(role in PATHS)) throw new BadRequest(`unknown role: ${role}`);
    const target = role as EditableAccessRole;

    // Delegated authorisation — see roles.ts → canEditAccessList.
    if (!canEditAccessList(ctx.roles, target)) {
      throw new Forbidden(
        `Role ${ctx.roles.primary} cannot edit the "${target}" access list. `
        + 'Only a strictly higher tier in the hierarchy may edit this list.',
      );
    }

    const path = PATHS[target];
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const next = normaliseList(body['emails']);

    // One-admin-minimum guard — never let the admin list go empty,
    // and never allow the caller to remove themselves from it. The
    // second clause prevents an admin from accidentally locking
    // themselves out via the Settings UI.
    if (target === 'admins') {
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
      `access: update ${target} list by ${actor}`,
      actor,
      existing?.sha,
    );
    await writeAudit(ctx.env, {
      actor,
      action: 'access-list:put',
      target: path,
      detail: `count=${next.length} by=${ctx.roles.primary}`,
    });
    invalidateCache();
    return ok(ctx.env, ctx.req, { saved: true, count: next.length });
  });
};
