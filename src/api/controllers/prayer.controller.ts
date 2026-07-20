import type { HttpRequest } from '../http/types';
import type { PrayerService } from '../../services/prayer.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makePrayerController(deps: { prayer: PrayerService }) {
  return {
    async list(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.prayer.list(req.ctx);
    },
    async create(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.prayer.create(req.ctx, req.body);
    },
    async listByStudent(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.prayer.listByStudent(req.ctx, req.params['studentId']!);
    },
    async update(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.prayer.update(req.ctx, req.params['id']!, req.body);
    },
    async setStatus(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.prayer.setStatus(req.ctx, req.params['id']!, req.body);
    },
    async remove(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      await deps.prayer.remove(req.ctx, req.params['id']!);
      return { ok: true };
    },
    async exportCsv(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.prayer.exportCsv(req.ctx);
    },
    async importCsv(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const body = req.body as { rows?: unknown };
      return deps.prayer.importCsv(req.ctx, body?.rows ?? []);
    },
  };
}
