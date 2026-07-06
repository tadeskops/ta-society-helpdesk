// In-app notification endpoints.
// Spec: tsh_requirement.md §19.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { NotFound } from '../lib/errors.ts';
import {
  NOTIFY_FLAG, listFor, countUnreadFor, markOneRead, markAllRead,
} from '../lib/notify.ts';

export const mountNotifications = (r: Router): void => {

  r.get('/notifications', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [NOTIFY_FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const me = ctx.identity!.email;
    const unread = ctx.url.searchParams.get('unread') === 'true';
    const limitStr = ctx.url.searchParams.get('limit');
    const opts: { unreadOnly?: boolean; limit?: number } = {};
    if (unread) opts.unreadOnly = true;
    if (limitStr) opts.limit = Math.max(1, Math.min(500, Number.parseInt(limitStr, 10) || 100));
    const items = await listFor(ctx.env, ctx.config, me, opts);
    const unreadCount = await countUnreadFor(ctx.env, ctx.config, me);
    return ok(ctx.env, ctx.req, { items, count: items.length, unread: unreadCount });
  });

  r.get('/notifications/count', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [NOTIFY_FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const unread = await countUnreadFor(ctx.env, ctx.config, ctx.identity!.email);
    return ok(ctx.env, ctx.req, { unread });
  });

  r.patch('/notifications/:id/read', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [NOTIFY_FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const updated = await markOneRead(ctx.env, ctx.config, params['id']!, ctx.identity!.email, ctx.identity!.email);
    if (!updated) throw new NotFound('Notification not found');
    return ok(ctx.env, ctx.req, { notification: updated });
  });

  r.post('/notifications/mark-all-read', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [NOTIFY_FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const n = await markAllRead(ctx.env, ctx.config, ctx.identity!.email, ctx.identity!.email);
    return ok(ctx.env, ctx.req, { updated: n });
  });
};
