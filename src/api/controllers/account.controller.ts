import type { HttpRequest } from '../http/types';
import type { AccountService } from '../../services/account.service';
import type { AuthService } from '../../services/auth.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makeAccountController(deps: { account: AccountService; auth: AuthService }) {
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
      // The caller's existing session token may still have mustChangePassword:
      // true baked in from login (resolveToken trusts the embedded actor, no DB
      // re-check) — issue a fresh one reflecting the just-cleared flag so the
      // client isn't stuck 403ing on MUST_CHANGE_PASSWORD for the rest of the
      // old token's TTL.
      const token = await deps.auth.issueTokenFor(req.ctx.id);
      return { ok: true, token };
    },

    async toggleStatus(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.account.toggleStatus(req.ctx, req.params['id']!);
    },

    async preview(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const user = await deps.account.previewAccount(req.ctx, req.params['id']!);
      const token = await deps.auth.issueTokenFor(user.id, { mustChangePassword: false });
      return { token, user: { ...user, mustChangePassword: false } };
    },

    async remove(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      await deps.account.remove(req.ctx, req.params['id']!);
      return { ok: true };
    },

    async planCohortLayout(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const { targetCohort } = req.body as { targetCohort: 'grades-quads' | 'none' };
      return deps.account.planCohortLayout(req.ctx, targetCohort);
    },

    async applyCohortLayout(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const { targetCohort } = req.body as { targetCohort: 'grades-quads' | 'none' };
      return deps.account.applyCohortLayout(req.ctx, targetCohort);
    },
  };
}
