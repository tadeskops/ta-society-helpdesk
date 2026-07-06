// GET /config — anonymous-safe (PII-free by design).
// PUT /config — admin-only; commits config/site.json + audit-log.
// Spec: tsh_requirement.md §5, §9, §14.2.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, isObj } from '../lib/validate.ts';
import { BadRequest } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { invalidateCache } from '../config/loader.ts';
import type { SiteConfig } from '../config/defaults.ts';

const SITE_PATH = 'config/site.json';

// Lightweight shape check — no deep schema validation, but reject
// obviously-wrong inputs that would brick the page.
const validateSiteShape = (raw: unknown): SiteConfig => {
  if (!isObj(raw)) throw new BadRequest('config must be a JSON object');
  if (!isObj(raw['features']))  throw new BadRequest('config.features missing');
  if (!isObj(raw['tunables']))  throw new BadRequest('config.tunables missing');
  if (!isObj(raw['lists']))     throw new BadRequest('config.lists missing');
  if (!isObj(raw['system']))    throw new BadRequest('config.system missing');
  for (const [k, v] of Object.entries(raw['features'] as Record<string, unknown>)) {
    if (typeof v !== 'boolean') throw new BadRequest(`features.${k} must be boolean`);
  }
  for (const [k, v] of Object.entries(raw['tunables'] as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest(`tunables.${k} must be a number`);
  }
  // ui block is optional but, if present, must be a plain object. Scalar
  // entries (defaultTheme, defaultFontScale, etc.) must be strings. The
  // `ui.collapse` slot is reserved for the collapsible-sections registry
  // override and accepts an object map of `{id: {collapsible:bool,
  // defaultCollapsed:bool}}` (both fields optional).
  if (raw['ui'] !== undefined) {
    if (!isObj(raw['ui'])) throw new BadRequest('config.ui must be an object');
    for (const [k, v] of Object.entries(raw['ui'] as Record<string, unknown>)) {
      if (k === 'collapse') {
        if (!isObj(v)) throw new BadRequest('ui.collapse must be an object');
        for (const [id, entry] of Object.entries(v as Record<string, unknown>)) {
          if (!isObj(entry)) throw new BadRequest(`ui.collapse.${id} must be an object`);
          const e = entry as Record<string, unknown>;
          if (e.collapsible !== undefined && typeof e.collapsible !== 'boolean') {
            throw new BadRequest(`ui.collapse.${id}.collapsible must be boolean`);
          }
          if (e.defaultCollapsed !== undefined && typeof e.defaultCollapsed !== 'boolean') {
            throw new BadRequest(`ui.collapse.${id}.defaultCollapsed must be boolean`);
          }
        }
        continue;
      }
      if (typeof v !== 'string') throw new BadRequest(`ui.${k} must be a string`);
    }
  }
  return raw as unknown as SiteConfig;
};

export const mountConfig = (r: Router): void => {
  // ---- GET /config (anonymous; PII-free) ----
  r.get('/config', (ctx: Ctx) => {
    ensureAllowed(ctx, {});
    return ok(ctx.env, ctx.req, ctx.config);
  });

  // ---- PUT /config (admin write) ----
  r.put('/config', async (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['ADMIN'], requireIdentity: true });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const next = validateSiteShape(body['config'] ?? body);
    const actor = ctx.identity!.email;

    const existing = await getFile(ctx.env, SITE_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(
      ctx.env,
      SITE_PATH,
      serialised,
      `settings: update site.json by ${actor}`,
      actor,
      existing?.sha,
    );
    await writeAudit(ctx.env, {
      actor,
      action: 'config:put',
      target: SITE_PATH,
      detail: `version=${next.version ?? '?'}`,
    });
    invalidateCache();
    return ok(ctx.env, ctx.req, { saved: true });
  });
};
