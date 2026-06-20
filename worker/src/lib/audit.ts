// Append-only audit log. One JSON object per line in config/audit.log.
// Spec: tsh_requirement.md §6.5, §13.

import type { Env } from '../env.ts';
import { appendToFile, getFile } from '../github/client.ts';

const AUDIT_PATH = 'config/audit.log';

export interface AuditEntry {
  at: string;        // ISO timestamp
  actor: string;     // verified email
  action: string;    // verb, e.g. 'config:put', 'access-list:put', 'issue:delete'
  target: string;    // path or issue id
  detail?: string;   // free text
}

export const writeAudit = async (env: Env, entry: Omit<AuditEntry, 'at'>): Promise<void> => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  await appendToFile(env, AUDIT_PATH, line, `audit: ${entry.action} ${entry.target}`.slice(0, 72), entry.actor);
};

export const readAudit = async (env: Env, limit = 200): Promise<AuditEntry[]> => {
  const f = await getFile(env, AUDIT_PATH);
  if (!f) return [];
  const out: AuditEntry[] = [];
  for (const raw of f.content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === '[]') continue;
    try {
      const obj = JSON.parse(line) as AuditEntry;
      if (obj && typeof obj.at === 'string') out.push(obj);
    } catch {
      // skip malformed
    }
  }
  return out.slice(-limit).reverse(); // newest first
};
