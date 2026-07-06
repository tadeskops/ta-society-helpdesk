// Polls with per-signed-in voter records and SVG bar charts.
// Routes:
//   GET  /polls               — anon list of active polls + tally + caller's vote (if signed in)
//   PUT  /polls               — MANAGER+/COMMITTEE+/ADMIN replace full poll list
//   POST /polls/:id/vote      — signed-in only; one vote per email per poll
//   GET  /polls/:id/votes     — MANAGER+ list voter records (email/alias/flat/timestamp)
//
// Storage:
//   config/polls.json       — poll definitions
//   config/poll-votes.json  — flat vote records
//
// Spec gates: FEATURE_DAILY_POLLS.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, str, optStr, isObj } from '../lib/validate.ts';
import { BadRequest, NotFound } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { tunable } from '../config/defaults.ts';

const POLLS_PATH = 'config/polls.json';
const VOTES_PATH = 'config/poll-votes.json';
const MAX_POLLS = 20;
const MAX_OPTIONS = 10;

interface PollOption { id: string; label: string; }
interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  expiresAt?: string;
  closed?: boolean;
  createdAt: string;
  createdBy: string;
}
interface PollList { version: number; items: Poll[]; }

interface VoteRecord {
  pollId: string;
  optionId: string;
  voterEmail: string;
  voterAlias?: string;
  voterFlat?: string;
  votedAt: string;
}
interface VoteStore { version: number; votes: VoteRecord[]; }

const EMPTY_POLLS: PollList = { version: 1, items: [] };
const EMPTY_VOTES: VoteStore = { version: 1, votes: [] };

interface PollsCache { value: PollList; sha?: string; expiresAt: number; }
let pollsCache: PollsCache | undefined;
const invalidatePolls = (): void => { pollsCache = undefined; };
let votesCache: { value: VoteStore; sha?: string; expiresAt: number } | undefined;
const invalidateVotes = (): void => { votesCache = undefined; };

export const _resetPollsCacheForTests = (): void => { pollsCache = undefined; votesCache = undefined; };

const loadPollsFromGithub = async (env: Ctx['env']): Promise<{ value: PollList; sha?: string }> => {
  const f = await getFile(env, POLLS_PATH);
  if (!f) return { value: structuredClone(EMPTY_POLLS) };
  try {
    const parsed = JSON.parse(f.content) as Partial<PollList>;
    return { value: { version: typeof parsed.version === 'number' ? parsed.version : 1, items: Array.isArray(parsed.items) ? (parsed.items as Poll[]) : [] }, sha: f.sha };
  } catch {
    return { value: structuredClone(EMPTY_POLLS), sha: f.sha };
  }
};

const loadVotesFromGithub = async (env: Ctx['env']): Promise<{ value: VoteStore; sha?: string }> => {
  const f = await getFile(env, VOTES_PATH);
  if (!f) return { value: structuredClone(EMPTY_VOTES) };
  try {
    const parsed = JSON.parse(f.content) as Partial<VoteStore>;
    return { value: { version: typeof parsed.version === 'number' ? parsed.version : 1, votes: Array.isArray(parsed.votes) ? (parsed.votes as VoteRecord[]) : [] }, sha: f.sha };
  } catch {
    return { value: structuredClone(EMPTY_VOTES), sha: f.sha };
  }
};

const loadPolls = async (ctx: Ctx): Promise<PollList> => {
  const now = Date.now();
  if (pollsCache && pollsCache.expiresAt > now) return pollsCache.value;
  const fresh = await loadPollsFromGithub(ctx.env);
  const ttl = tunable(ctx.config, 'POLLS_CACHE_SECONDS', 60) * 1000;
  pollsCache = { value: fresh.value, expiresAt: now + ttl, ...(fresh.sha !== undefined ? { sha: fresh.sha } : {}) };
  return fresh.value;
};

const loadVotes = async (ctx: Ctx): Promise<VoteStore> => {
  const now = Date.now();
  if (votesCache && votesCache.expiresAt > now) return votesCache.value;
  const fresh = await loadVotesFromGithub(ctx.env);
  const ttl = tunable(ctx.config, 'POLLS_VOTES_CACHE_SECONDS', 30) * 1000;
  votesCache = { value: fresh.value, expiresAt: now + ttl, ...(fresh.sha !== undefined ? { sha: fresh.sha } : {}) };
  return fresh.value;
};

const cryptoRandomId = (prefix: string): string => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex}`;
};

const sanitisePoll = (raw: unknown, actor: string): Poll => {
  if (!isObj(raw)) throw new BadRequest('poll must be an object');
  const question = str(raw['question'], 'poll.question', { min: 1, max: 240 });
  const optionsRaw = Array.isArray(raw['options']) ? raw['options'] : [];
  if (optionsRaw.length < 2) throw new BadRequest('poll must have at least 2 options');
  if (optionsRaw.length > MAX_OPTIONS) throw new BadRequest(`poll supports at most ${MAX_OPTIONS} options`);
  const options: PollOption[] = optionsRaw.map((o, idx) => {
    if (!isObj(o)) throw new BadRequest(`poll.options[${idx}] must be an object`);
    const label = str(o['label'], `poll.options[${idx}].label`, { min: 1, max: 120 });
    return {
      id: typeof o['id'] === 'string' && o['id'] ? o['id'] : cryptoRandomId('opt'),
      label,
    };
  });
  // Reject duplicate option ids inside the same poll.
  const ids = new Set<string>();
  for (const o of options) {
    if (ids.has(o.id)) throw new BadRequest('poll option ids must be unique within a poll');
    ids.add(o.id);
  }
  const out: Poll = {
    id: typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : cryptoRandomId('pol'),
    question,
    options,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : new Date().toISOString(),
    createdBy: typeof raw['createdBy'] === 'string' && raw['createdBy'] ? raw['createdBy'] : actor,
  };
  if (raw['closed'] === true) out.closed = true;
  const exp = optStr(raw['expiresAt'], 'poll.expiresAt', { max: 40 });
  if (exp) {
    const t = Date.parse(exp);
    if (Number.isNaN(t)) throw new BadRequest('poll.expiresAt must be ISO 8601');
    out.expiresAt = new Date(t).toISOString();
  }
  return out;
};

const isPollOpen = (p: Poll): boolean => {
  if (p.closed) return false;
  if (p.expiresAt) {
    const t = Date.parse(p.expiresAt);
    if (!Number.isNaN(t) && t < Date.now()) return false;
  }
  return true;
};

const tallyPoll = (poll: Poll, store: VoteStore): { optionId: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const o of poll.options) counts.set(o.id, 0);
  for (const v of store.votes) {
    if (v.pollId !== poll.id) continue;
    counts.set(v.optionId, (counts.get(v.optionId) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([optionId, count]) => ({ optionId, count }));
};

export const mountPolls = (r: Router): void => {
  // ---- GET /polls ----
  r.get('/polls', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_POLLS'] });
    const polls = await loadPolls(ctx);
    const votes = await loadVotes(ctx);
    const myEmail = ctx.identity?.email;
    const items = polls.items.map((p) => ({
      ...p,
      open: isPollOpen(p),
      totals: tallyPoll(p, votes),
      myVote: myEmail ? (votes.votes.find((v) => v.pollId === p.id && v.voterEmail === myEmail)?.optionId || null) : null,
    }));
    return ok(ctx.env, ctx.req, { version: polls.version, items });
  });

  // ---- PUT /polls ----
  r.put('/polls', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_POLLS'],
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
      requireIdentity: true,
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const incoming = (body['polls'] ?? body) as Record<string, unknown>;
    if (!isObj(incoming)) throw new BadRequest('polls must be an object');
    const itemsRaw = Array.isArray(incoming['items']) ? incoming['items'] : [];
    if (itemsRaw.length > MAX_POLLS) throw new BadRequest(`polls supports at most ${MAX_POLLS}`);
    const actor = ctx.identity!.email;
    const next: PollList = {
      version: typeof incoming['version'] === 'number' ? (incoming['version'] as number) : 1,
      items: itemsRaw.map((p) => sanitisePoll(p, actor)),
    };
    // Reject duplicate poll ids across the list.
    const seen = new Set<string>();
    for (const p of next.items) {
      if (seen.has(p.id)) throw new BadRequest('poll ids must be unique');
      seen.add(p.id);
    }
    const existing = await getFile(ctx.env, POLLS_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(ctx.env, POLLS_PATH, serialised, `polls: update by ${actor}`, actor, existing?.sha);
    await writeAudit(ctx.env, { actor, action: 'polls:put', target: POLLS_PATH, detail: `polls=${next.items.length}` });
    invalidatePolls();
    return ok(ctx.env, ctx.req, { saved: true, count: next.items.length });
  });

  // ---- POST /polls/:id/vote ----
  r.post('/polls/:id/vote', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_POLLS'], requireIdentity: true });
    const pollId = params['id'];
    if (!pollId) throw new BadRequest('poll id required');
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const optionId = str(body['optionId'], 'optionId', { min: 1, max: 80 });
    const voterAlias = optStr(body['voterAlias'], 'voterAlias', { max: 60 });
    const voterFlat  = optStr(body['voterFlat'],  'voterFlat',  { max: 30 });

    const polls = await loadPolls(ctx);
    const poll = polls.items.find((p) => p.id === pollId);
    if (!poll) throw new NotFound('poll not found');
    if (!isPollOpen(poll)) throw new BadRequest('poll is closed');
    if (!poll.options.some((o) => o.id === optionId)) throw new BadRequest('optionId not in this poll');

    const votes = await loadVotes(ctx);
    const voterEmail = ctx.identity!.email;
    const existingIdx = votes.votes.findIndex((v) => v.pollId === pollId && v.voterEmail === voterEmail);
    const record: VoteRecord = {
      pollId, optionId, voterEmail,
      votedAt: new Date().toISOString(),
      ...(voterAlias ? { voterAlias } : {}),
      ...(voterFlat  ? { voterFlat  } : {}),
    };
    if (existingIdx >= 0) votes.votes[existingIdx] = record;
    else votes.votes.push(record);

    const existing = await getFile(ctx.env, VOTES_PATH);
    const serialised = JSON.stringify(votes, null, 2) + '\n';
    await putFile(ctx.env, VOTES_PATH, serialised, `polls: vote on ${pollId} by ${voterEmail}`, voterEmail, existing?.sha);
    await writeAudit(ctx.env, { actor: voterEmail, action: 'polls:vote', target: pollId, detail: `option=${optionId}` });
    invalidateVotes();
    return ok(ctx.env, ctx.req, { saved: true, totals: tallyPoll(poll, votes), myVote: optionId });
  });

  // ---- GET /polls/:id/votes (MANAGER+ list voters) ----
  r.get('/polls/:id/votes', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_POLLS'],
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
      requireIdentity: true,
    });
    const pollId = params['id'];
    if (!pollId) throw new BadRequest('poll id required');
    const votes = await loadVotes(ctx);
    const list = votes.votes.filter((v) => v.pollId === pollId);
    return ok(ctx.env, ctx.req, { pollId, count: list.length, voters: list });
  });
};
