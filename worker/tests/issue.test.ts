// Pure-function tests for lib/issue.ts. No mocks needed.

import { describe, it, expect } from 'vitest';
import {
  padId, formatTitle, buildInitialLabels, statusOf, severityOf,
  setStatus, setPrefixed, isAllowedTransition, buildBody, parseBody,
  toPublicIssue, tombstoneBody, auditComment, appendPhotos, writeResolution,
} from '../src/lib/issue.ts';
import type { GhIssue } from '../src/github/client.ts';

const lbl = (...names: string[]) => names.map((n) => ({ name: n }));

describe('padId / formatTitle', () => {
  it('zero-pads issue number to 5 digits with DLY- prefix (legacy storage key)', () => {
    expect(padId(1)).toBe('DLY-00001');
    expect(padId(42)).toBe('DLY-00042');
    expect(padId(99999)).toBe('DLY-99999');
  });
  it('formats title from the display id', () => {
    expect(formatTitle('TKT-2806260345', 'Lift', 'T2')).toBe('TKT-2806260345 · Lift · T2');
  });
});

describe('buildInitialLabels', () => {
  it('always includes new + daily + tower + category prefixes', () => {
    const labels = buildInitialLabels('T2', 'Lift');
    expect(labels).toContain('new');
    expect(labels).toContain('daily');
    expect(labels).toContain('tower:T2');
    expect(labels).toContain('cat:lift');
  });
});

describe('statusOf / severityOf / setStatus / setPrefixed', () => {
  it('reads the status label from a label set', () => {
    expect(statusOf(lbl('daily', 'tower:T1', 'in-progress'))).toBe('in-progress');
    expect(statusOf(lbl('daily', 'tower:T1'))).toBeUndefined();
  });
  it('reads severity', () => {
    expect(severityOf(lbl('sev:high', 'new'))).toBe('high');
    expect(severityOf(lbl('sev:bogus', 'new'))).toBeUndefined();
  });
  it('replaces the status label', () => {
    const next = setStatus(lbl('daily', 'tower:T1', 'new'), 'assigned');
    expect(next).toContain('assigned');
    expect(next).not.toContain('new');
    expect(next).toContain('daily');
    expect(next).toContain('tower:T1');
  });
  it('replaces a prefixed label and keeps others', () => {
    const next = setPrefixed(lbl('sev:low', 'daily', 'new'), 'sev', 'critical');
    expect(next).toContain('sev:critical');
    expect(next).not.toContain('sev:low');
    expect(next).toContain('new');
  });
});

describe('isAllowedTransition (§7 lifecycle table)', () => {
  it.each([
    ['new', 'triaging'],
    ['new', 'assigned'],
    ['new', 'rejected'],
    ['triaging', 'assigned'],
    ['triaging', 'rejected'],
    ['assigned', 'in-progress'],
    ['assigned', 'resolved'],
    ['in-progress', 'resolved'],
    ['resolved', 'in-progress'],
    ['rejected', 'new'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(true);
  });

  it.each([
    ['new', 'in-progress'],
    ['new', 'resolved'],
    ['triaging', 'in-progress'],
    ['resolved', 'new'],
    ['resolved', 'rejected'],
    ['rejected', 'assigned'],
    ['assigned', 'new'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(false);
  });

  it('forbids self-transitions', () => {
    expect(isAllowedTransition('new', 'new')).toBe(false);
    expect(isAllowedTransition('resolved', 'resolved')).toBe(false);
  });

  it('never allows direct -> deleted (soft-delete is its own path)', () => {
    expect(isAllowedTransition('new', 'deleted')).toBe(false);
    expect(isAllowedTransition('resolved', 'deleted')).toBe(false);
  });
});

describe('buildBody / parseBody round-trip', () => {
  it('round-trips required fields', () => {
    const body = buildBody({
      tower: 'T2',
      location: 'Lift lobby',
      category: 'Lift',
      subCategory: 'Doors not closing',
      description: 'Doors keep sticking on G floor.',
      reporterName: 'Asha',
      reporterFlat: 'B-204',
      reporterPhone: '+919876543210',
      notifyWhatsapp: true,
    });
    const parsed = parseBody(body);
    expect(parsed.reported.tower).toBe('T2');
    expect(parsed.reported.location).toBe('Lift lobby');
    expect(parsed.reported.category).toBe('Lift');
    expect(parsed.reported.subCategory).toBe('Doors not closing');
    expect(parsed.reporter.name).toBe('Asha');
    expect(parsed.reporter.flat).toBe('B-204');
    expect(parsed.reporter.phone).toBe('+919876543210');
    expect(parsed.reporter.notifyWhatsapp).toBe(true);
    expect(parsed.description).toContain('sticking');
  });
});

describe('toPublicIssue — PII scrub (§5.2, §15.1)', () => {
  const env = { GH_OWNER: 'tadeskops', GH_REPO: 'ta-society-helpdesk', GH_BRANCH: 'main' } as any;
  const body = buildBody({
    tower: 'T3', location: 'Pump room 9876543210',
    category: 'Water', subCategory: 'Leak',
    description: 'Call me on +91 9876 5432 10 please',
    reporterName: 'Reza', reporterFlat: 'C-101', reporterPhone: '+919876543210',
    notifyWhatsapp: false,
  });
  const issue: GhIssue = {
    number: 7, title: 'DLY-00007 · Water · T3', body,
    labels: lbl('daily', 'tower:T3', 'new', 'cat:water'),
    state: 'open', locked: false,
    html_url: 'https://github.com/x/y/issues/7',
    created_at: '2026-06-20T00:00:00Z', updated_at: '2026-06-20T00:00:00Z',
  };

  it('never includes reporter fields in the public projection', () => {
    const pub = JSON.stringify(toPublicIssue(issue, { includePhotos: true }));
    expect(pub).not.toContain('Reza');
    expect(pub).not.toContain('C-101');
    expect(pub).not.toContain('9876543210');
  });
  it('redacts phone-shaped substrings in description and location', () => {
    const pub = toPublicIssue(issue, { includePhotos: true });
    expect(pub.description).toContain('[redacted]');
    expect(pub.location).toContain('[redacted]');
  });
  it('omits resolutionNotes until status is resolved', () => {
    const pub = toPublicIssue(issue, { includePhotos: true });
    expect(pub.resolutionNotes).toBeUndefined();
  });
});

describe('writeResolution / appendPhotos / tombstoneBody / auditComment', () => {
  it('writes a fresh Resolution section', () => {
    const start = buildBody({
      tower: 'T1', location: 'Lobby', category: 'Lights',
      subCategory: 'Other', description: 'Bulb out',
    });
    const next = writeResolution(start, 'fixer@example.com', 'Replaced LED', 250);
    expect(next).toMatch(/### Resolution \(set on RESOLVED\)/);
    expect(next).toMatch(/- By: fixer@example\.com/);
    expect(next).toMatch(/- Notes: Replaced LED/);
    expect(next).toMatch(/- Cost: 250/);
  });
  it('appends photo lines (idempotent for an empty Photos section)', () => {
    const start = buildBody({
      tower: 'T1', location: 'X', category: 'Lift', subCategory: 'Other', description: 'asdf',
    });
    const next = appendPhotos(start, ['https://x/01.jpg', 'https://x/02.jpg']);
    expect(next).toContain('![](https://x/01.jpg)');
    expect(next).toContain('![](https://x/02.jpg)');
    expect(next).not.toContain('(none)'); // placeholder removed
  });
  it('tombstoneBody is canonical', () => {
    const t = tombstoneBody('dev@example.com');
    expect(t).toMatch(/^\[REDACTED — deleted by dev@example\.com at .+\]$/);
  });
  it('auditComment includes the §6.4 fields', () => {
    const c = auditComment('new', 'assigned', 'mgr@x.com', 'Vendor: Otis');
    expect(c).toContain('**Status change**');
    expect(c).toContain('- From: new → assigned');
    expect(c).toContain('- By: mgr@x.com');
    expect(c).toContain('- Notes: Vendor: Otis');
  });
});
