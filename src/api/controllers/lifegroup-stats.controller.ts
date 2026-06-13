import type { HttpRequest } from '../http/types';
import type { LifegroupStatsService } from '../../services/lifegroup-stats.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makeLifegroupStatsController(deps: { lifegroupStats: LifegroupStatsService }) {
  return {
    async get(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.lifegroupStats.get(req.ctx);
    },
  };
}
