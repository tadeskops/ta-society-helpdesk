// Issue body + label helpers. The Worker is the only writer; the
// shape below is the single source of truth. Spec: tsh_requirement.md
// §6 (title / body / labels / soft-delete).

import type { GhIssue } from '../github/client.ts';
import type { Env } from '../env.ts';

export type Status =
  | 'new' | 'triaging' | 'assigned'
  | 'in-progress' | 'resolved' | 'rejected' | 'deleted';

export const STATUSES: readonly Status[] = [
  'new', 'triaging', 'assigned', 'in-progress', 'resolved', 'rejected', 'deleted',
] as const;

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'] as const;

export const SYSTEM_LABEL = 'daily';

// ---- Title ----------------------------------------------------------------

/**
 * Legacy storage key. Kept for backward compatibility with photos already
 * committed under `photos/DLY-NNNNN/` in the issues repo — internal only,
 * never shown to users. Display IDs go through `displayIdOf` / `formatTktBase`.
 */
export const padId = (num: number): string => `DLY-${String(num).padStart(5, '0')}`;

// ---- Ticket ID (TKT-DDMMYYHHMM[-N], IST) ----------------------------------

// India Standard Time = UTC+5:30 (no DST).
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * Computes the base ticket id from an ISO timestamp using IST.
 * Returns `TKT-DDMMYYHHMM` (10 digits after the prefix).
 */
export const formatTktBase = (createdAt: string): string => {
  const t = new Date(createdAt).getTime();
  const ist = new Date(t + IST_OFFSET_MS);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(ist.getUTCFullYear() % 100).padStart(2, '0');
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mn = String(ist.getUTCMinutes()).padStart(2, '0');
  return `TKT-${dd}${mm}${yy}${hh}${mn}`;
};

/** Accept-pattern for parsing a user-supplied ticket id. */
export const TKT_ID_RE = /^TKT-\d{10}(?:-\d+)?$/;

/** Read the persisted ticket id from an issue's labels, if any. */
export const tktLabelOf = (issue: { labels: { name: string }[] }): string | undefined => {
  const lab = issue.labels.find((l) => l.name.startsWith('tkt:'));
  return lab ? lab.name.slice(4) : undefined;
};

/**
 * The public-facing display id for an issue.
 * Prefers the persisted `tkt:` label; falls back to a computed base id from
 * `created_at` (so old issues without the label still render a TKT- id even
 * before backfill — collision-free for any minute with a single ticket).
 */
export const displayIdOf = (issue: { labels: { name: string }[]; created_at: string }): string =>
  tktLabelOf(issue) ?? formatTktBase(issue.created_at);

export const formatTitle = (id: string, category: string, tower: string): string =>
  `${id} · ${category} · ${tower}`;

/** Public raw-file URL for a photo committed to the repo. */
export const photoRawUrl = (env: Env, issueNum: number, file: string): string =>
  `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_BRANCH}/photos/${padId(issueNum)}/${file}`;

export const photoRepoPath = (issueNum: number, file: string): string =>
  `photos/${padId(issueNum)}/${file}`;

// ---- Labels ---------------------------------------------------------------

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const towerLabel    = (t: string): string => `tower:${t}`;
export const categoryLabel = (c: string): string => `cat:${slug(c)}`;
export const severityLabel = (s: Severity): string => `sev:${s}`;

export const buildInitialLabels = (tower: string, category: string): string[] => [
  'new', SYSTEM_LABEL, towerLabel(tower), categoryLabel(category),
];

export const statusOf = (labels: { name: string }[]): Status | undefined =>
  labels.map((l) => l.name).find((n): n is Status => (STATUSES as readonly string[]).includes(n));

export const severityOf = (labels: { name: string }[]): Severity | undefined => {
  for (const l of labels) {
    const m = /^sev:(.+)$/.exec(l.name);
    if (m && (SEVERITIES as readonly string[]).includes(m[1]!)) return m[1] as Severity;
  }
  return undefined;
};

export const towerOf = (labels: { name: string }[]): string | undefined => {
  for (const l of labels) {
    const m = /^tower:(.+)$/.exec(l.name);
    if (m) return m[1];
  }
  return undefined;
};

export const categoryFromLabels = (labels: { name: string }[]): string | undefined => {
  for (const l of labels) {
    const m = /^cat:(.+)$/.exec(l.name);
    if (m) return m[1];
  }
  return undefined;
};

/** Replace any existing status label with `next`; preserve everything else. */
export const setStatus = (labels: { name: string }[], next: Status): string[] => {
  const out = labels.map((l) => l.name).filter((n) => !(STATUSES as readonly string[]).includes(n));
  out.push(next);
  return out;
};

/** Replace any existing label that starts with `prefix:` with `prefix:value`. */
export const setPrefixed = (labels: { name: string }[], prefix: string, value: string): string[] => {
  const out = labels.map((l) => l.name).filter((n) => !n.startsWith(`${prefix}:`));
  out.push(`${prefix}:${value}`);
  return out;
};

export const isDeleted = (issue: { labels: { name: string }[] }): boolean =>
  issue.labels.some((l) => l.name === 'deleted');

// ---- Body builder ---------------------------------------------------------

export interface NewIssueFields {
  tower: string;
  location: string;
  category: string;
  subCategory: string;
  description: string;
  reporterName?: string | undefined;
  reporterFlat?: string | undefined;
  reporterPhone?: string | undefined;
  notifyWhatsapp?: boolean | undefined;
  photoUrls?: string[];
}

export const buildBody = (f: NewIssueFields): string => {
  const lines: string[] = [];
  lines.push('### Reported');
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Tower: ${f.tower}`);
  lines.push(`- Location: ${f.location}`);
  lines.push(`- Category: ${f.category}`);
  lines.push(`- Sub-category: ${f.subCategory}`);
  lines.push('');
  lines.push('### Reporter');
  lines.push(`- Name: ${f.reporterName ?? ''}`);
  lines.push(`- Flat: ${f.reporterFlat ?? ''}`);
  lines.push(`- Phone: ${f.reporterPhone ?? ''}`);
  lines.push(`- Notify on WhatsApp: ${f.notifyWhatsapp ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('### Description');
  lines.push(f.description);
  lines.push('');
  lines.push('### Photos');
  if (f.photoUrls && f.photoUrls.length) {
    for (const u of f.photoUrls) lines.push(`- ![](${u})`);
  } else {
    lines.push('- (none)');
  }
  lines.push('');
  lines.push('### Resolution (set on RESOLVED)');
  lines.push('- By: ');
  lines.push('- Date: ');
  lines.push('- Notes: ');
  lines.push('- Cost: ');
  lines.push('');
  return lines.join('\n');
};

export interface ParsedBody {
  reported: { date?: string; tower?: string; location?: string; category?: string; subCategory?: string };
  reporter: { name?: string; flat?: string; phone?: string; notifyWhatsapp?: boolean };
  description: string;
  photoUrls: string[];
  resolution: { by?: string; date?: string; notes?: string; cost?: string };
}

const sectionAt = (body: string, header: string): string => {
  // Split body on "### " headers. parts[0] is the preamble (before any
  // ###); each subsequent piece is "<Header>\n<content...>". Stop at
  // the next "### " or end of input — no regex lookahead needed.
  const target = header.toLowerCase();
  const pieces = body.split(/(?:^|\n)### /);
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const nl = piece.indexOf('\n');
    const head = (nl === -1 ? piece : piece.slice(0, nl)).trim().toLowerCase();
    if (head === target) {
      return nl === -1 ? '' : piece.slice(nl + 1).trimEnd();
    }
  }
  return '';
};

const kv = (section: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of section.split(/\r?\n/)) {
    const m = /^-\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1]!.trim().toLowerCase()] = m[2]!.trim();
  }
  return out;
};

export const parseBody = (body: string): ParsedBody => {
  const reported = kv(sectionAt(body, 'Reported'));
  const reporter = kv(sectionAt(body, 'Reporter'));
  const description = sectionAt(body, 'Description');
  const photos = sectionAt(body, 'Photos');
  const resolution = kv(sectionAt(body, 'Resolution (set on RESOLVED)'));

  const photoUrls: string[] = [];
  for (const line of photos.split(/\r?\n/)) {
    const m = /!\[[^\]]*\]\(([^)]+)\)/.exec(line);
    if (m) photoUrls.push(m[1]!);
  }

  const result: ParsedBody = {
    reported: {},
    reporter: {},
    description,
    photoUrls,
    resolution: {},
  };
  if (reported['date'])         result.reported.date         = reported['date'];
  if (reported['tower'])        result.reported.tower        = reported['tower'];
  if (reported['location'])     result.reported.location     = reported['location'];
  if (reported['category'])     result.reported.category     = reported['category'];
  if (reported['sub-category']) result.reported.subCategory  = reported['sub-category'];
  if (reporter['name'])         result.reporter.name         = reporter['name'];
  if (reporter['flat'])         result.reporter.flat         = reporter['flat'];
  if (reporter['phone'])        result.reporter.phone        = reporter['phone'];
  if (reporter['notify on whatsapp']) {
    result.reporter.notifyWhatsapp = /^yes$/i.test(reporter['notify on whatsapp']);
  }
  if (resolution['by'])    result.resolution.by    = resolution['by'];
  if (resolution['date'])  result.resolution.date  = resolution['date'];
  if (resolution['notes']) result.resolution.notes = resolution['notes'];
  if (resolution['cost'])  result.resolution.cost  = resolution['cost'];
  return result;
};

// ---- PII scrub for public read endpoints ----------------------------------

// Anything that looks phone-shaped: 10+ digits possibly with separators / + prefix.
const PHONE_RE = /(\+?\d[\d\s\-().]{8,}\d)/g;

const scrubPhones = (s: string): string =>
  s.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D+/g, '');
    return digits.length >= 10 ? '[redacted]' : m;
  });

export interface PublicIssue {
  id: string;                 // TKT-DDMMYYHHMM[-N]
  number: number;
  title: string;              // also redacted, in case category contained a phone (it can't, but defence)
  status: Status | 'unknown';
  tower?: string;
  category?: string;
  severity?: Severity;
  description: string;        // phone-scrubbed
  location?: string;          // phone-scrubbed
  photoUrls: string[];
  resolutionNotes?: string;   // only when status is 'resolved'
  createdAt: string;
  updatedAt: string;
  url: string;
}

/** Build the PII-redacted public view of an issue. Strips reporter section entirely. */
export const toPublicIssue = (issue: GhIssue, opts: { includePhotos?: boolean }): PublicIssue => {
  const parsed = parseBody(issue.body ?? '');
  const status = statusOf(issue.labels) ?? 'unknown';
  const sev = severityOf(issue.labels);
  const result: PublicIssue = {
    id: displayIdOf(issue),
    number: issue.number,
    title: scrubPhones(issue.title),
    status,
    description: scrubPhones(parsed.description),
    photoUrls: opts.includePhotos !== false ? parsed.photoUrls : [],
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: issue.html_url,
  };
  const tower = towerOf(issue.labels);
  if (tower) result.tower = tower;
  const cat = parsed.reported.category ?? categoryFromLabels(issue.labels);
  if (cat) result.category = cat;
  if (sev) result.severity = sev;
  if (parsed.reported.location) result.location = scrubPhones(parsed.reported.location);
  if (status === 'resolved' && parsed.resolution.notes) {
    result.resolutionNotes = scrubPhones(parsed.resolution.notes);
  }
  return result;
};

// ---- Tombstone for soft-delete --------------------------------------------

export const tombstoneBody = (email: string): string =>
  `[REDACTED — deleted by ${email} at ${new Date().toISOString()}]`;

// ---- Audit comment for status transitions ---------------------------------

export const auditComment = (from: Status, to: Status, actor: string, notes?: string): string => {
  const lines = [
    '**Status change**',
    `- From: ${from} → ${to}`,
    `- By: ${actor}`,
    `- At: ${new Date().toISOString()}`,
  ];
  if (notes && notes.trim()) lines.push(`- Notes: ${notes.trim()}`);
  return lines.join('\n');
};

// ---- Lifecycle table (§7) -------------------------------------------------
//
// Default flow (minimized): new → assigned → in-progress → resolved
// (plus rejected + deleted sinks). A scheduled sweep auto-transitions
// `new` → `assigned` after DAILY_AUTO_ASSIGN_HOURS (default 4h) — see
// routes/issues.ts → runAutoAssignSweep. The `triaging` status is retained
// as an outgoing-only state so any pre-existing ticket that was manually
// moved into `triaging` in the past still has a forward path; new tickets
// no longer enter that state.

type Edge = { from: Status; to: Status };
const ALLOWED_EDGES: Edge[] = [
  { from: 'new',         to: 'assigned' },
  { from: 'new',         to: 'rejected' },
  { from: 'triaging',    to: 'assigned' },   // legacy tickets only
  { from: 'triaging',    to: 'rejected' },   // legacy tickets only
  { from: 'assigned',    to: 'in-progress' },
  { from: 'assigned',    to: 'resolved' },
  { from: 'assigned',    to: 'rejected' },
  { from: 'in-progress', to: 'resolved' },
  { from: 'in-progress', to: 'rejected' },
  { from: 'resolved',    to: 'in-progress' },
  { from: 'rejected',    to: 'new' },
];

export const isAllowedTransition = (from: Status, to: Status): boolean =>
  ALLOWED_EDGES.some((e) => e.from === from && e.to === to);

/** Write the resolution section into the body (mutates and returns). */
export const writeResolution = (body: string, by: string, notes: string, cost?: number): string => {
  const replacement = [
    '### Resolution (set on RESOLVED)',
    `- By: ${by}`,
    `- Date: ${new Date().toISOString()}`,
    `- Notes: ${notes}`,
    `- Cost: ${cost ?? ''}`,
  ].join('\n');
  return replaceSection(body, 'Resolution (set on RESOLVED)', replacement);
};

/** Append photo lines to the body's Photos section. Removes the
 *  `- (none)` placeholder if present. */
export const appendPhotos = (body: string, urls: string[]): string => {
  if (!urls.length) return body;
  const newLines = urls.map((u) => `- ![](${u})`);
  const existing = sectionAt(body, 'Photos');
  const merged = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== '- (none)');
  for (const l of newLines) merged.push(l);
  const next = ['### Photos', ...merged].join('\n');
  return replaceSection(body, 'Photos', next);
};

/** Replace (or append) a whole "### Header\n<content>" section. */
const replaceSection = (body: string, header: string, replacement: string): string => {
  const target = header.toLowerCase();
  const headerRe = /(^|\n)### ([^\n]+)/g;
  type Hit = { start: number; end: number; head: string };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(body)) !== null) {
    hits.push({ start: m.index + (m[1] ? 1 : 0), end: -1, head: m[2]!.trim().toLowerCase() });
  }
  for (let i = 0; i < hits.length; i++) {
    hits[i]!.end = i + 1 < hits.length ? hits[i + 1]!.start : body.length;
  }
  const hit = hits.find((h) => h.head === target);
  if (!hit) {
    return body.replace(/\s*$/, '\n\n') + replacement + '\n';
  }
  const before = body.slice(0, hit.start);
  const after  = body.slice(hit.end);
  const sep = replacement.endsWith('\n') ? '' : '\n';
  return before + replacement + sep + (after.startsWith('\n') ? '' : '\n') + after;
};
