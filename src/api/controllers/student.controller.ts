import type { HttpRequest } from '../http/types';
import type { StudentService } from '../../services/student.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makeStudentController(deps: { student: StudentService }) {
  return {
    async list(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const grade = req.query['grade'] ? parseInt(req.query['grade']!, 10) : undefined;
      const gender = req.query['gender'];
      const query = req.query['q'];
      const crossGrade = req.query['crossGrade'] === '1' || req.query['crossGrade'] === 'true';
      return deps.student.list(req.ctx, { grade, gender, query, crossGrade });
    },

    async get(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.student.get(req.ctx, req.params['id']!);
    },

    async create(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.student.create(req.ctx, req.body);
    },

    async update(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.student.update(req.ctx, req.params['id']!, req.body);
    },

    async updateAtRisk(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const { status } = req.body as { status: string };
      return deps.student.updateAtRisk(req.ctx, req.params['id']!, status);
    },

    async remove(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      await deps.student.remove(req.ctx, req.params['id']!);
      return { ok: true };
    },

    async search(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const q = req.query['q'] ?? '';
      return deps.student.search(req.ctx, q);
    },
  };
}
