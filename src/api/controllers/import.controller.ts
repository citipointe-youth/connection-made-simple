import type { HttpRequest } from '../http/types';
import type { ImportService } from '../../services/import.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makeImportController(deps: { importService: ImportService }) {
  return {
    async importCsv(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const body = req.body as { rows?: unknown[]; filename?: string };
      return deps.importService.importServiceCsv(
        req.ctx,
        body.rows ?? [],
        body.filename ?? 'upload.csv',
      );
    },

    async importGroupCsv(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const body = req.body as { groups?: unknown; filename?: string };
      return deps.importService.importGroupCsv(
        req.ctx,
        { groups: body.groups ?? [] },
        body.filename ?? 'upload.csv',
      );
    },

    async history(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.importService.listHistory(req.ctx);
    },
  };
}
