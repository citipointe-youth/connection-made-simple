import type { HttpRequest } from '../http/types';
import type { LeaderService } from '../../services/leader.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makeLeaderController(deps: { leader: LeaderService }) {
  return {
    async list(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.leader.list(req.ctx);
    },

    async get(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.leader.get(req.ctx, req.params['id']!);
    },

    async create(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.leader.create(req.ctx, req.body);
    },

    async update(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.leader.update(req.ctx, req.params['id']!, req.body);
    },

    async remove(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      await deps.leader.remove(req.ctx, req.params['id']!);
      return { ok: true };
    },

    async updateSmsTemplate(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const body = req.body as { smsTemplate?: unknown };
      return deps.leader.updateSmsTemplate(req.ctx, req.params['id']!, body?.smsTemplate ?? null);
    },

    async updateGrades(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const body = req.body as { grades?: unknown };
      return deps.leader.updateGrades(req.ctx, req.params['id']!, body?.grades ?? []);
    },
  };
}
