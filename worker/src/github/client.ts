// Minimal GitHub REST client. All writes go through here.
// PAT lives only in env.GITHUB_TOKEN; never leaves the Worker.
// Spec: tsh_requirement.md §10 (GITHUB_TOKEN scopes: issues:write, contents:write).

import type { Env } from '../env.ts';
import { UpstreamError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

const API = 'https://api.github.com';

const headers = (env: Env): HeadersInit => ({
  'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'tsh-worker',
});

const repoPath = (env: Env): string => `${env.GH_OWNER}/${env.GH_REPO}`;

export interface GithubFile {
  sha: string;
  content: string;
  encoding: 'base64' | 'utf-8';
}

const b64encode = (s: string): string => {
  // Workers runtime provides btoa; encodes Latin-1 only, so go via UTF-8 bytes.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const b64decode = (s: string): string => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const getFile = async (env: Env, path: string): Promise<GithubFile | undefined> => {
  const url = `${API}/repos/${repoPath(env)}/contents/${encodeURI(path)}?ref=${env.GH_BRANCH}`;
  const res = await fetch(url, { headers: headers(env) });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    log.error(env, 'github_get_file_failed', { path, status: res.status });
    throw new UpstreamError(`GitHub getFile ${path} -> ${res.status}`);
  }
  const json = (await res.json()) as { sha: string; content: string; encoding: 'base64' };
  return {
    sha: json.sha,
    content: b64decode(json.content.replace(/\n/g, '')),
    encoding: 'utf-8',
  };
};

export const getJson = async <T>(env: Env, path: string): Promise<T | undefined> => {
  const f = await getFile(env, path);
  if (!f) return undefined;
  try {
    return JSON.parse(f.content) as T;
  } catch {
    log.warn(env, 'github_get_json_parse_failed', { path });
    return undefined;
  }
};

export const putFile = async (
  env: Env,
  path: string,
  content: string,
  message: string,
  authorEmail: string,
  prevSha?: string,
): Promise<{ sha: string }> => {
  const url = `${API}/repos/${repoPath(env)}/contents/${encodeURI(path)}`;
  const body: Record<string, unknown> = {
    message,
    content: b64encode(content),
    branch: env.GH_BRANCH,
    committer: { name: 'tsh-worker', email: 'tsh-worker@users.noreply.github.com' },
    author: { name: 'tsh-worker', email: authorEmail },
  };
  if (prevSha) body['sha'] = prevSha;
  const res = await fetch(url, { method: 'PUT', headers: { ...headers(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    log.error(env, 'github_put_file_failed', { path, status: res.status, body: text.slice(0, 200) });
    throw new UpstreamError(`GitHub putFile ${path} -> ${res.status}`);
  }
  const json = (await res.json()) as { content: { sha: string } };
  return { sha: json.content.sha };
};

export const appendToFile = async (
  env: Env,
  path: string,
  line: string,
  message: string,
  authorEmail: string,
): Promise<void> => {
  const existing = await getFile(env, path);
  const next = (existing?.content ?? '') + (line.endsWith('\n') ? line : line + '\n');
  await putFile(env, path, next, message, authorEmail, existing?.sha);
};

/** Upload a binary file whose content is already base64-encoded. */
export const putBinaryB64 = async (
  env: Env,
  path: string,
  contentB64: string,
  message: string,
  authorEmail: string,
): Promise<{ sha: string }> => {
  const url = `${API}/repos/${repoPath(env)}/contents/${encodeURI(path)}`;
  const existing = await getFile(env, path);
  const body: Record<string, unknown> = {
    message,
    content: contentB64,
    branch: env.GH_BRANCH,
    committer: { name: 'tsh-worker', email: 'tsh-worker@users.noreply.github.com' },
    author: { name: 'tsh-worker', email: authorEmail },
  };
  if (existing) body['sha'] = existing.sha;
  const res = await fetch(url, { method: 'PUT', headers: { ...headers(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    log.error(env, 'github_put_binary_failed', { path, status: res.status, body: text.slice(0, 200) });
    throw new UpstreamError(`GitHub putBinary ${path} -> ${res.status}`);
  }
  const json = (await res.json()) as { content: { sha: string } };
  return { sha: json.content.sha };
};

// ---- Issues ---------------------------------------------------------------

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  state: 'open' | 'closed';
  locked: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export const createIssue = async (env: Env, params: {
  title: string;
  body: string;
  labels: string[];
}): Promise<GhIssue> => {
  const url = `${API}/repos/${repoPath(env)}/issues`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text();
    log.error(env, 'github_create_issue_failed', { status: res.status, body: text.slice(0, 200) });
    throw new UpstreamError(`GitHub createIssue -> ${res.status}`);
  }
  return (await res.json()) as GhIssue;
};

export const listIssues = async (env: Env, params: {
  labels?: string[];
  state?: 'open' | 'closed' | 'all';
  per_page?: number;
}): Promise<GhIssue[]> => {
  const q = new URLSearchParams();
  if (params.labels && params.labels.length) q.set('labels', params.labels.join(','));
  q.set('state', params.state ?? 'all');
  q.set('per_page', String(params.per_page ?? 100));
  const url = `${API}/repos/${repoPath(env)}/issues?${q.toString()}`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new UpstreamError(`GitHub listIssues -> ${res.status}`);
  return (await res.json()) as GhIssue[];
};

export const getIssue = async (env: Env, num: number): Promise<GhIssue | undefined> => {
  const url = `${API}/repos/${repoPath(env)}/issues/${num}`;
  const res = await fetch(url, { headers: headers(env) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new UpstreamError(`GitHub getIssue -> ${res.status}`);
  return (await res.json()) as GhIssue;
};

export const updateIssue = async (env: Env, num: number, patch: Partial<{
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
}>): Promise<GhIssue> => {
  const url = `${API}/repos/${repoPath(env)}/issues/${num}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new UpstreamError(`GitHub updateIssue -> ${res.status}`);
  return (await res.json()) as GhIssue;
};

export const lockIssue = async (env: Env, num: number, reason = 'resolved'): Promise<void> => {
  const url = `${API}/repos/${repoPath(env)}/issues/${num}/lock`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ lock_reason: reason }),
  });
  if (!res.ok && res.status !== 204) throw new UpstreamError(`GitHub lockIssue -> ${res.status}`);
};

export const commentOnIssue = async (env: Env, num: number, body: string): Promise<void> => {
  const url = `${API}/repos/${repoPath(env)}/issues/${num}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new UpstreamError(`GitHub comment -> ${res.status}`);
};
