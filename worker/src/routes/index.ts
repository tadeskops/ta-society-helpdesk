// Route registry. All 13 spec routes (§5) are mounted here. Per-area
// handlers live alongside this file (whoami, config, issues, public,
// access, audit).

import { Router } from '../lib/router.ts';
import { mountWhoami } from './whoami.ts';
import { mountConfig } from './config.ts';
import { mountIssues } from './issues.ts';
import { mountPublic } from './public.ts';
import { mountAccess } from './access.ts';
import { mountAudit } from './audit.ts';
import { mountDirectory } from './directory.ts';
import { mountBanner } from './banner.ts';
import { mountAnnouncements } from './announcements.ts';
import { mountEvents } from './events.ts';
import { mountPolls } from './polls.ts';
import { mountMetrics } from './metrics.ts';
import { mountBackup } from './backup.ts';
import { mountReservations } from './reservations.ts';

export const buildRouter = (): Router => {
  const r = new Router();
  mountWhoami(r);
  mountConfig(r);
  mountIssues(r);
  mountPublic(r);
  mountAccess(r);
  mountAudit(r);
  mountDirectory(r);
  mountBanner(r);
  mountAnnouncements(r);
  mountEvents(r);
  mountPolls(r);
  mountMetrics(r);
  mountBackup(r);
  mountReservations(r);
  return r;
};

