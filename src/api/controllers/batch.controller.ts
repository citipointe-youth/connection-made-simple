import type { HttpRequest } from '../http/types';
import type { Actor } from '../../core/entities/user';
import { UnauthorizedError, BadRequestError } from '../../core/errors/app-error';
import type { OverviewService } from '../../services/overview.service';
import type { TrendsService } from '../../services/trends.service';
import type { StudentService } from '../../services/student.service';
import type { LifegroupStatsService } from '../../services/lifegroup-stats.service';
import type { ConnectionService } from '../../services/connection.service';
import type { AtRiskService } from '../../services/atrisk.service';
import type { SettingsService } from '../../services/settings.service';
import type { LeaderService } from '../../services/leader.service';

// The batch endpoint composes the existing per-screen services into ONE request so a
// page load is one serverless invocation (and one Supabase pooler connection-set)
// instead of the 5-9 separate requests the SPA used to fan out. Each section just
// delegates to the service that already backs its standalone endpoint, so RBAC
// scoping and each service's ResponseCache are inherited unchanged — this file adds
// no business logic of its own. See docs/superpowers/specs/2026-07-05-batch-endpoint-design.md.
export function makeBatchController(deps: {
  overview: OverviewService;
  trends: TrendsService;
  student: StudentService;
  lifegroupStats: LifegroupStatsService;
  connection: ConnectionService;
  atRisk: AtRiskService;
  settings: SettingsService;
  leader: LeaderService;
}) {
  // key -> the same call the standalone controller makes. `settings` ignores the
  // actor (its standalone route is public), the rest are actor-scoped.
  const handlers: Record<string, (ctx: Actor) => Promise<unknown>> = {
    overview: (ctx) => deps.overview.getStats(ctx),
    trends: (ctx) => deps.trends.get(ctx),
    students: (ctx) => deps.student.list(ctx, {}),
    lifegroupStats: (ctx) => deps.lifegroupStats.get(ctx),
    connections: (ctx) => deps.connection.listAll(ctx),
    atRisk: (ctx) => deps.atRisk.list(ctx),
    settings: () => deps.settings.get(),
    leaders: (ctx) => deps.leader.list(ctx),
    // Connect Setup's own widened fetch — see student.service.ts's list() `crossGrade`
    // comment for why this needs to be a separate section, not a swap-in-place for
    // `students`/`connections` (those two feed screens that must stay grade-scoped).
    studentsConnect: (ctx) => deps.student.list(ctx, { crossGrade: true }),
    connectionsConnect: (ctx) => deps.connection.listAll(ctx, { crossGrade: true }),
  };

  return {
    async get(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const ctx = req.ctx;

      const raw = req.query['sections'];
      if (!raw) throw new BadRequestError('sections query param is required');
      const requested = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
      if (requested.length === 0) throw new BadRequestError('sections query param is required');

      const results: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      // Run every requested section concurrently; a failure in one is isolated to its
      // own `errors` entry (best-effort partial render) instead of failing the page.
      // Within this single invocation, dedupeReads coalesces the shared table reads
      // (students/sessions/attendance/...) that these services issue.
      await Promise.all(
        requested.map(async (key) => {
          const handler = handlers[key];
          if (!handler) {
            errors[key] = 'unknown section';
            return;
          }
          try {
            results[key] = await handler(ctx);
          } catch (e) {
            errors[key] = e instanceof Error ? e.message : String(e);
          }
        }),
      );

      return { results, errors };
    },
  };
}
