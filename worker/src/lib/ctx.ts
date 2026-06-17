// Per-request context assembled by middleware. Routes never reach
// directly for env/config — they read from here.

import type { Env } from '../env.ts';
import type { Identity } from '../auth/jwt.ts';
import type { RoleSet } from '../auth/roles.ts';
import type { SiteConfig, AccessLists } from '../config/loader.ts';

export interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  identity?: Identity;   // undefined for anonymous-allowed routes
  roles: RoleSet;
  config: SiteConfig;
  access: AccessLists;
  ip: string;
}
