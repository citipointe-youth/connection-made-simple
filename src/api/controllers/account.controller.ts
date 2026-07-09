import type { HttpRequest } from '../http/types';
import type { AccountService } from '../../services/account.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makeAccountController(deps: { account: AccountService }) {
  return {
    async list(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.account.list(req.ctx);
    },

    async create(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.account.create(req.ctx, req.body);
    },

    async update(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.account.update(req.ctx, req.params['id']!, req.body);
    },

    async setPassword(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const { id, password } = req.body as { id: string; password: string };
      await deps.account.setPassword(req.ctx, id, password);
      return { ok: true };
    },

    async changeOwnPassword(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
      await deps.account.changeOwnPassword(req.ctx, currentPassword, newPassword);
      return { ok: true };
    },

    async toggleStatus(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.account.toggleStatus(req.ctx, req.params['id']!);
    },

    async remove(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      await deps.account.remove(req.ctx, req.params['id']!);
      return { ok: true };
    },
  };
}
