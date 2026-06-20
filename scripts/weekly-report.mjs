// scripts/weekly-report.mjs
// Generates two PDFs from the GitHub Issues data:
//   backups/TSH_Report.pdf       (anonymised)
//   backups/TSH_Full_Report.pdf  (full)
//
// Reads issues directly from the GitHub REST API (no Worker dependency)
// so the report can run even if the Worker is down. PII redaction
// matches the rules baked into worker/src/lib/issue.ts (toPublicIssue).
//
// Env:
//   GH_TOKEN   - GITHUB_TOKEN (auto from Actions)
//   REPO       - owner/name
//   WORKER_URL - (optional) used only to record source-of-truth url in PDF
import { mkdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const REPO = process.env.REPO;
const GH_TOKEN = process.env.GH_TOKEN;
if (!REPO || !GH_TOKEN) {
  console.error('REPO and GH_TOKEN are required');
  process.exit(1);
}
const [OWNER, NAME] = REPO.split('/');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'backups');
mkdirSync(OUT_DIR, { recursive: true });

async function ghJson(url) {
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'tsh-weekly-report',
    },
  });
  if (!r.ok) throw new Error(`GitHub ${url} -> ${r.status}`);
  return r.json();
}

async function listAllDailyIssues() {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.github.com/repos/${OWNER}/${NAME}/issues?state=all&labels=daily&per_page=100&page=${page}`;
    const batch = await ghJson(url);
    if (!batch.length) break;
    for (const it of batch) {
      if (it.pull_request) continue;
      items.push(it);
    }
    if (batch.length < 100) break;
  }
  return items;
}

function labelsOf(issue) { return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)); }
function fromPrefix(labels, prefix) {
  const m = labels.find((l) => l.startsWith(prefix));
  return m ? m.slice(prefix.length) : '';
}
function isDeleted(labels) { return labels.includes('deleted'); }

function parseBody(body) {
  const out = { reported: {}, reporter: {}, description: '', resolution: {} };
  if (!body) return out;
  const sections = body.split(/(?:^|\n)### /);
  for (let i = 1; i < sections.length; i++) {
    const p = sections[i];
    const nl = p.indexOf('\n');
    const head = (nl === -1 ? p : p.slice(0, nl)).trim();
    const content = nl === -1 ? '' : p.slice(nl + 1).trimEnd();
    if (head === 'Reported')                      kv(out.reported, content);
    else if (head === 'Reporter')                 kv(out.reporter, content);
    else if (head === 'Description')              out.description = content.trim();
    else if (head.startsWith('Resolution'))       kv(out.resolution, content);
  }
  return out;
}
function kv(target, content) {
  for (const line of content.split(/\r?\n/)) {
    const m = /^-\s*([^:]+):\s*(.*)$/.exec(line);
    if (m) target[m[1].trim()] = m[2].trim();
  }
}

function redactPhone(s) { return (s || '').replace(/(?:\+?\d[\d\s\-()]{8,}\d)/g, '[redacted]'); }

function makePdf(filePath, title, items, { redact }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const stream = doc.pipe(createWriteStream(filePath));

  doc.fontSize(20).text(title, { align: 'left' });
  doc.fontSize(10).fillColor('#666').text(`Generated ${new Date().toISOString()} · ${items.length} ticket(s)`);
  doc.moveDown(0.5);
  doc.fillColor('#000');

  if (process.env.WORKER_URL) {
    doc.fontSize(8).fillColor('#888').text(`Source: ${process.env.WORKER_URL}/issues  (public/private depending on report)`);
    doc.moveDown(0.5);
    doc.fillColor('#000');
  }

  for (const it of items) {
    const labels = labelsOf(it);
    if (isDeleted(labels)) continue;
    const status = fromPrefix(labels, 'status:') || 'new';
    const severity = fromPrefix(labels, 'severity:');
    const tower = fromPrefix(labels, 'tower:');
    const category = fromPrefix(labels, 'cat:');
    const parsed = parseBody(it.body);

    doc.fontSize(12).fillColor('#0d6f6f').text(it.title || `Issue #${it.number}`);
    doc.fontSize(9).fillColor('#666').text(
      `tower=${tower}  category=${category}  status=${status}  severity=${severity || '—'}  created=${new Date(it.created_at).toISOString().slice(0, 10)}`,
    );
    doc.fillColor('#000').fontSize(10);

    const loc = parsed.reported && parsed.reported.Location;
    if (loc) doc.text('Location: ' + (redact ? redactPhone(loc) : loc));

    if (parsed.description) {
      doc.text((redact ? redactPhone(parsed.description) : parsed.description), { indent: 0, width: 500 });
    }

    if (!redact && parsed.reporter && Object.values(parsed.reporter).some(Boolean)) {
      doc.fontSize(9).fillColor('#444').text(
        `Reporter: ${parsed.reporter.Name || '—'} · ${parsed.reporter.Flat || '—'} · ${parsed.reporter.Phone || '—'}`,
      );
    }

    if (parsed.resolution && parsed.resolution.Notes) {
      doc.fontSize(9).fillColor('#2e7d32').text('Resolved: ' + parsed.resolution.Notes);
    }
    doc.fillColor('#000');
    doc.moveDown(0.5);
  }

  doc.end();
  return new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); });
}

const all = await listAllDailyIssues();
console.log(`Fetched ${all.length} daily issue(s).`);

await makePdf(path.join(OUT_DIR, 'TSH_Report.pdf'),      'TSH Daily Track — Public Report',    all, { redact: true });
await makePdf(path.join(OUT_DIR, 'TSH_Full_Report.pdf'), 'TSH Daily Track — Full Report',      all, { redact: false });

console.log('PDFs written to backups/.');
