import type { HttpRequest } from '../http/types';
import type { ConnectionAuditService } from '../../services/connection-audit.service';
import { UnauthorizedError, BadRequestError } from '../../core/errors/app-error';

export function makeConnectionAuditController(deps: { connectionAudit: ConnectionAuditService }) {
  return {
    async upload(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connectionAudit.upload(req.ctx, req.body);
    },
    async list(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connectionAudit.list(req.ctx);
    },
    async get(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const year = Number(req.params?.['year']);
      if (!Number.isInteger(year)) throw new BadRequestError('Invalid year');
      return deps.connectionAudit.get(req.ctx, year);
    },
    async remove(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const year = Number(req.params?.['year']);
      if (!Number.isInteger(year)) throw new BadRequestError('Invalid year');
      await deps.connectionAudit.remove(req.ctx, year);
      return { ok: true };
    },
    async finalizeFromLive(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connectionAudit.finalizeFromLive(req.ctx);
    },
    async exportAll(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connectionAudit.exportAll(req.ctx);
    },
    async importAll(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connectionAudit.importAll(req.ctx, req.body);
    },
  };
}
