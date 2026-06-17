// Tiny path-parameter router. Patterns: '/issues', '/issues/:id', '/issues/:id/photos'.

import type { Ctx } from './ctx.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Handler = (ctx: Ctx, params: Record<string, string>) => Promise<Response> | Response;

interface Route {
  method: Method;
  pattern: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler): void {
    this.routes.push({ method, pattern, segments: pattern.split('/').filter(Boolean), handler });
  }

  get(p: string, h: Handler)    { this.add('GET',    p, h); }
  post(p: string, h: Handler)   { this.add('POST',   p, h); }
  put(p: string, h: Handler)    { this.add('PUT',    p, h); }
  patch(p: string, h: Handler)  { this.add('PATCH',  p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | undefined {
    const segs = path.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method) continue;
      if (r.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const ps = r.segments[i]!;
        const cs = segs[i]!;
        if (ps.startsWith(':')) params[ps.slice(1)] = decodeURIComponent(cs);
        else if (ps !== cs) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return undefined;
  }
}
