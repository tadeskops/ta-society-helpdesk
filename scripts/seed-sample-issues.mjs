#!/usr/bin/env node
/**
 * seed-sample-issues.mjs
 * -----------------------------------------------------------------------------
 * Seed a batch of demonstration "Daily Track" issues into the configured
 * GitHub Issues repo. Bypasses the Worker / Turnstile and writes directly via
 * the GitHub REST API using the same body+labels format the Worker produces
 * (see worker/src/lib/issue.ts -> buildBody / buildInitialLabels).
 *
 * Usage (PowerShell):
 *   $env:GH_TOKEN = "ghp_xxx_token_with_repo_scope"
 *   node scripts/seed-sample-issues.mjs                  # dry-run (no writes)
 *   node scripts/seed-sample-issues.mjs --apply          # create the issues
 *   node scripts/seed-sample-issues.mjs --apply --count 5
 *   node scripts/seed-sample-issues.mjs --cleanup        # close + tag as deleted any
 *                                                       # previously-seeded demo issues
 *   node scripts/seed-sample-issues.mjs --owner ... --repo ... --branch ...
 *
 * Identification: every seeded issue carries the label "seed:demo" and the
 * marker "<!-- TSH_SEED_DEMO -->" at the top of the body, so --cleanup can find
 * and soft-delete them later without touching real reports.
 */

import process from 'node:process';

// ---- CLI args --------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const APPLY    = has('--apply');
const CLEANUP  = has('--cleanup');
const COUNT    = parseInt(arg('--count', '0'), 10) || 0;  // 0 = all
const OWNER    = arg('--owner', 'tadeskops');
const REPO     = arg('--repo',  'ta-society-helpdesk');
const BRANCH   = arg('--branch','main');
const TOKEN    = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('ERROR: set GH_TOKEN (or GITHUB_TOKEN) env var with `repo` scope.');
  process.exit(2);
}

const API = 'https://api.github.com';
const HEADERS = {
  'Accept':              'application/vnd.github+json',
  'Authorization':       `Bearer ${TOKEN}`,
  'X-GitHub-Api-Version':'2022-11-28',
  'User-Agent':          'tsh-seed-script',
};

const SEED_MARKER = '<!-- TSH_SEED_DEMO -->';
const SEED_LABEL  = 'seed:demo';
const SYSTEM_LABEL = 'daily';
const STATUSES = ['new','triaging','assigned','in-progress','resolved','rejected','deleted'];

// ---- Helpers mirroring worker/src/lib/issue.ts -----------------------------

const padId = (n) => `DLY-${String(n).padStart(5, '0')}`;
const slug  = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const towerLabel    = (t) => `tower:${t}`;
const categoryLabel = (c) => `cat:${slug(c)}`;
const severityLabel = (s) => `sev:${s}`;
const formatTitle   = (n, cat, tower) => `${padId(n)} · ${cat} · ${tower}`;
const buildInitialLabels = (tower, category) => [
  'new', SYSTEM_LABEL, towerLabel(tower), categoryLabel(category), SEED_LABEL,
];

function buildBody(f) {
  const lines = [];
  lines.push(SEED_MARKER);
  lines.push('### Reported');
  lines.push(`- Date: ${(f.reportedAt || new Date()).toISOString()}`);
  lines.push(`- Tower: ${f.tower}`);
  lines.push(`- Location: ${f.location}`);
  lines.push(`- Category: ${f.category}`);
  lines.push(`- Sub-category: ${f.subCategory}`);
  lines.push('');
  lines.push('### Reporter');
  lines.push(`- Name: ${f.reporterName || ''}`);
  lines.push(`- Flat: ${f.reporterFlat || ''}`);
  lines.push(`- Phone: ${f.reporterPhone || ''}`);
  lines.push(`- Notify on WhatsApp: ${f.notifyWhatsapp ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('### Description');
  lines.push(f.description);
  lines.push('');
  lines.push('### Photos');
  lines.push('- (none)');
  lines.push('');
  lines.push('### Resolution (set on RESOLVED)');
  lines.push(`- By: ${f.resolvedBy || ''}`);
  lines.push(`- Date: ${f.resolvedDate || ''}`);
  lines.push(`- Notes: ${f.resolvedNotes || ''}`);
  lines.push(`- Cost: ${f.resolvedCost || ''}`);
  lines.push('');
  return lines.join('\n');
}

// ---- Seed data --------------------------------------------------------------

/**
 * Each entry mirrors the worker's NewIssueFields plus a `status` (label
 * other than "new") and optional `severity`. Pick from the configured
 * towers/categories so labels look correct in the dashboards.
 */
const SAMPLES = [
  { tower: 'A', location: 'Flat A-1204',         category: 'Water',          subCategory: 'No supply',          severity: 'high',     status: 'new',
    description: 'No water supply since 7am. Other flats on the same column also report no flow.',
    reporterName: 'Anjali Mehta',    reporterFlat: 'A-1204', reporterPhone: '+91 98765 43210', notifyWhatsapp: true },

  { tower: 'B', location: 'Lift 2',              category: 'Lift',           subCategory: 'Stuck',              severity: 'critical', status: 'in-progress',
    description: 'Lift 2 stuck between floors 8 and 9. Two residents inside, both safe. Service engineer notified.',
    reporterName: 'Rohit Khanna',    reporterFlat: 'B-0903', reporterPhone: '+91 99887 12345', notifyWhatsapp: true },

  { tower: 'A', location: 'Basement P2 ramp',    category: 'Electricity',    subCategory: 'Common-area outage', severity: 'high',     status: 'assigned',
    description: 'Ramp lights to P2 not working since last night. Safety concern for vehicles.',
    reporterName: 'Priya Sharma',    reporterFlat: 'A-0405', reporterPhone: '+91 91234 56789' },

  { tower: 'C', location: 'Flat C-307 bathroom', category: 'Plumbing',       subCategory: 'Leak',               severity: 'medium',   status: 'triaging',
    description: 'Ceiling leak in master bathroom. Water dripping from light fixture; suspect leak from C-407 above.',
    reporterName: 'Suresh Iyer',     reporterFlat: 'C-0307', reporterPhone: '+91 98112 23344' },

  { tower: 'Common Area', location: 'Clubhouse ground floor', category: 'Cleaning', subCategory: 'Spillage', severity: 'low', status: 'resolved',
    description: 'Juice spill near the reception desk. Slip hazard.',
    reporterName: 'Front Desk',      reporterFlat: '',       reporterPhone: '',
    resolvedBy: 'Cleaning Supervisor', resolvedDate: '2026-06-18', resolvedNotes: 'Mopped and dried within 15 minutes.', resolvedCost: '0' },

  { tower: 'B', location: 'Tower B main gate',   category: 'Security',       subCategory: 'Gate',               severity: 'medium',   status: 'in-progress',
    description: 'Pedestrian gate latch broken; gate swings open on its own. Temporary chain fitted.',
    reporterName: 'Watchman (Day)',  reporterFlat: '',       reporterPhone: '+91 90000 11111' },

  { tower: 'Common Area', location: 'Garden – east lawn', category: 'Garden', subCategory: 'Tree fall risk',    severity: 'high',     status: 'triaging',
    description: 'Large branch on the gulmohar tree has cracked and is hanging over the children\u2019s play area.',
    reporterName: 'Vikram Rao',      reporterFlat: 'A-0207', reporterPhone: '+91 93210 88776' },

  { tower: 'A', location: 'Garbage bay',         category: 'Waste Management', subCategory: 'Missed pickup',    severity: 'medium',   status: 'new',
    description: 'Wet-waste pickup missed for the second day. Bins overflowing and starting to smell.',
    reporterName: 'Neha Kapoor',     reporterFlat: 'A-0801', reporterPhone: '+91 98123 45678', notifyWhatsapp: true },

  { tower: 'Common Area', location: 'Swimming pool', category: 'Swimming Pool', subCategory: 'Water quality',  severity: 'high',     status: 'assigned',
    description: 'Pool water cloudy, slight chlorine smell. Closed pool until water test result is back.',
    reporterName: 'Pool Attendant',  reporterFlat: '',       reporterPhone: '' },

  { tower: 'C', location: 'Tower C lobby',       category: 'CCTV',           subCategory: 'Camera offline',     severity: 'medium',   status: 'in-progress',
    description: 'Lobby CCTV offline since power cut on 19th. Recording gap for the last 36 hours.',
    reporterName: 'Manager',         reporterFlat: '',       reporterPhone: '+91 90000 22222' },

  { tower: 'B', location: 'Flat B-1502 kitchen', category: 'Pest Control',   subCategory: 'Cockroach',          severity: 'low',      status: 'resolved',
    description: 'Heavy cockroach infestation reported. Treated under the monthly contract.',
    reporterName: 'Mrs. Banerjee',   reporterFlat: 'B-1502', reporterPhone: '+91 98765 99887',
    resolvedBy: 'Pest contractor', resolvedDate: '2026-06-19', resolvedNotes: 'Gel + spray treatment. Follow-up scheduled in 14 days.', resolvedCost: '1200' },

  { tower: 'Common Area', location: 'Basement parking row 3', category: 'Parking', subCategory: 'Unauthorised vehicle', severity: 'low', status: 'rejected',
    description: 'Strange car parked in slot B-302 since two days. Owner not reachable.',
    reporterName: 'Watchman (Night)',reporterFlat: '',       reporterPhone: '+91 90000 33333',
    resolvedBy: 'Manager', resolvedDate: '2026-06-19', resolvedNotes: 'Vehicle belongs to B-302 owner\u2019s guest. Valid; closing as not an issue.', resolvedCost: '0' },

  { tower: 'A', location: 'Fire pump room',      category: 'Fire Safety',    subCategory: 'Sprinkler',          severity: 'critical', status: 'assigned',
    description: 'Sprinkler line pressure dropped to 4 bar (should be 7). Pump short-cycling. AMC vendor notified.',
    reporterName: 'Maintenance',     reporterFlat: '',       reporterPhone: '+91 90000 44444', notifyWhatsapp: true },

  { tower: 'C', location: 'Gym',                 category: 'Gym',            subCategory: 'Equipment broken',   severity: 'low',      status: 'triaging',
    description: 'Treadmill #2 belt slipping. Roped off for now.',
    reporterName: 'Gym in-charge',   reporterFlat: '',       reporterPhone: '' },

  { tower: 'B', location: 'Flat B-0203 hall',    category: 'Building & Civil', subCategory: 'Seepage',          severity: 'medium',   status: 'new',
    description: 'Seepage stain spreading along the wall shared with the elevator shaft. Started after recent rain.',
    reporterName: 'Ramesh Pillai',   reporterFlat: 'B-0203', reporterPhone: '+91 99001 22334' },
];

// ---- GitHub REST helpers ---------------------------------------------------

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { /* ignore */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
  }
  return json;
}

async function createIssue({ title, body, labels }) {
  return gh('POST', `/repos/${OWNER}/${REPO}/issues`, { title, body, labels });
}

async function patchIssue(number, patch) {
  return gh('PATCH', `/repos/${OWNER}/${REPO}/issues/${number}`, patch);
}

async function listSeededOpen() {
  // Find all open issues we previously seeded (label seed:demo). The API
  // paginates at 100 per page; sample size is small so 1 page is fine.
  return gh('GET',
    `/repos/${OWNER}/${REPO}/issues?state=open&labels=${encodeURIComponent(SEED_LABEL)}&per_page=100`);
}

// ---- Apply / dry-run logic -------------------------------------------------

async function applySamples() {
  const work = COUNT > 0 ? SAMPLES.slice(0, COUNT) : SAMPLES;
  console.log(`Seeding ${work.length} issue(s) into ${OWNER}/${REPO}@${BRANCH} ...`);

  let okCount = 0;
  for (const [i, s] of work.entries()) {
    try {
      const initialLabels = buildInitialLabels(s.tower, s.category);
      // 1) Create with placeholder title (we don't yet know the issue number).
      const created = await createIssue({
        title: formatTitle(0, s.category, s.tower),
        body:  buildBody(s),
        labels: initialLabels,
      });
      // 2) Patch the title with the real DLY-<n>, swap "new" -> requested status,
      //    and add severity label if requested.
      const labels = initialLabels.filter((l) => l !== 'new');
      if (s.status && STATUSES.includes(s.status)) labels.push(s.status);
      else                                          labels.push('new');
      if (s.severity) labels.push(severityLabel(s.severity));
      await patchIssue(created.number, {
        title: formatTitle(created.number, s.category, s.tower),
        labels,
      });
      okCount++;
      console.log(`  [${i + 1}/${work.length}] #${created.number} ${padId(created.number)} · ${s.category} · ${s.tower}  (status=${s.status || 'new'}${s.severity ? `, sev=${s.severity}` : ''})`);
    } catch (e) {
      console.error(`  [${i + 1}/${work.length}] FAILED: ${e.message}`);
    }
  }
  console.log(`Done. Created ${okCount}/${work.length}.`);
}

async function cleanupSamples() {
  console.log(`Cleaning up previously-seeded demo issues in ${OWNER}/${REPO} ...`);
  const open = await listSeededOpen();
  if (!Array.isArray(open) || open.length === 0) {
    console.log('  Nothing to clean up.');
    return;
  }
  let okCount = 0;
  for (const it of open) {
    try {
      // Mirror the worker's soft-delete: add "deleted" label, remove status
      // labels, then close the issue.
      const labels = (it.labels || [])
        .map((l) => (typeof l === 'string' ? l : l.name))
        .filter((n) => !STATUSES.includes(n));
      labels.push('deleted');
      await patchIssue(it.number, { state: 'closed', labels });
      okCount++;
      console.log(`  closed #${it.number} (${it.title})`);
    } catch (e) {
      console.error(`  FAILED #${it.number}: ${e.message}`);
    }
  }
  console.log(`Done. Cleaned up ${okCount}/${open.length}.`);
}

function dryRun() {
  const work = COUNT > 0 ? SAMPLES.slice(0, COUNT) : SAMPLES;
  console.log(`DRY RUN — would create ${work.length} issue(s) in ${OWNER}/${REPO}@${BRANCH}`);
  console.log('(use --apply to actually create them; --cleanup to remove previously-seeded ones)\n');
  for (const [i, s] of work.entries()) {
    const labels = [
      ...buildInitialLabels(s.tower, s.category).filter((l) => l !== 'new'),
      s.status || 'new',
      ...(s.severity ? [severityLabel(s.severity)] : []),
    ];
    console.log(`  ${String(i + 1).padStart(2)}. ${s.category.padEnd(18)} | ${s.tower.padEnd(11)} | ${(s.subCategory + ' @ ' + s.location).padEnd(45)} | sev=${s.severity || '-'} | status=${s.status || 'new'}`);
    console.log(`      labels: ${labels.join(', ')}`);
  }
}

// ---- Entry point ----------------------------------------------------------

(async () => {
  try {
    if (CLEANUP) {
      if (!APPLY) {
        console.log('Pass --apply alongside --cleanup to actually close the seeded issues.');
        console.log('Showing what would be cleaned up:');
        const open = await listSeededOpen();
        console.log(`  ${open.length} issue(s) tagged "${SEED_LABEL}" currently open.`);
        for (const it of open) console.log(`    #${it.number}  ${it.title}`);
        return;
      }
      await cleanupSamples();
      return;
    }
    if (!APPLY) { dryRun(); return; }
    await applySamples();
  } catch (e) {
    console.error('Fatal:', e.message);
    process.exit(1);
  }
})();
