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

export const padId = (num: number): string => `DLY-${String(num).padStart(5, '0')}`;
export const formatTitle = (num: number, category: string, tower: string): string =>
  `${padId(num)} · ${category} · ${tower}`;

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
  const re = new RegExp(`^### ${header}\\b([\\s\\S]*?)(?=^### |\\s*$)`, 'm');
  const m = re.exec(body);
  return (m?.[1] ?? '').trim();
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
  const resolution = kv(sectionAt(body, 'Resolution \\(set on RESOLVED\\)'));

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
  id: string;                 // DLY-00142
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
    id: padId(issue.number),
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

type Edge = { from: Status; to: Status };
const ALLOWED_EDGES: Edge[] = [
  { from: 'new',         to: 'triaging' },
  { from: 'new',         to: 'assigned' },
  { from: 'new',         to: 'rejected' },
  { from: 'triaging',    to: 'assigned' },
  { from: 'triaging',    to: 'rejected' },
  { from: 'assigned',    to: 'in-progress' },
  { from: 'assigned',    to: 'resolved' },
  { from: 'in-progress', to: 'resolved' },
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
  // Replace any prior Resolution section to keep history clean.
  if (/^### Resolution/m.test(body)) {
    return body.replace(/^### Resolution[\s\S]*$/m, replacement);
  }
  return body.trimEnd() + '\n\n' + replacement + '\n';
};

/** Append photo lines to the body's Photos section. */
export const appendPhotos = (body: string, urls: string[]): string => {
  if (!urls.length) return body;
  const photoLines = urls.map((u) => `- ![](${u})`).join('\n');
  if (/^### Photos\b[\s\S]*?(?=^### |\s*$)/m.test(body)) {
    return body.replace(/^### Photos\b([\s\S]*?)(?=^### |\s*$)/m, (_whole, section: string) => {
      const cleaned = section.replace(/^- \(none\)\s*$/m, '').trimEnd();
      return `### Photos${cleaned ? cleaned + '\n' : '\n'}${photoLines}\n\n`;
    });
  }
  return body.trimEnd() + '\n\n### Photos\n' + photoLines + '\n';
};
