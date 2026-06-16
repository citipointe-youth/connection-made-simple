import type { HttpRequest } from '../http/types';
import type { ConnectionService } from '../../services/connection.service';
import { UnauthorizedError } from '../../core/errors/app-error';

export function makeConnectionController(deps: { connection: ConnectionService }) {
  return {
    async listAll(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connection.listAll(req.ctx);
    },

    async listByStudent(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connection.listByStudent(req.ctx, req.params['studentId']!);
    },

    async listByLeader(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connection.listByLeader(req.ctx, req.params['leaderId']!);
    },

    async assign(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connection.assign(req.ctx, req.body);
    },

    async unassign(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const { studentId, leaderId } = req.params;
      await deps.connection.unassign(req.ctx, studentId!, leaderId!);
      return { ok: true };
    },

    async leaderSummary(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      return deps.connection.leaderSummary(req.ctx, req.params['leaderId']!);
    },

    async exportCsv(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const rows = await deps.connection.exportCsv(req.ctx);
      // Return as CSV string
      const header = 'Leader,Leader Gender,Leader Grades,Student,Grade,Gender,Svc Attended,Svc Total,Svc %,At Risk';
      const lines = rows.map((r) =>
        [r.leaderName, r.leaderGender ?? '', r.leaderGrades, r.studentName, r.studentGrade ?? '', r.studentGender, r.svcAttended, r.svcTotal, r.svcPct, r.atRiskStatus ?? '']
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      );
      return { csv: [header, ...lines].join('\n'), rowCount: rows.length };
    },

    async exportAllocations(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const rows = await deps.connection.exportAllocations(req.ctx);
      const header = 'First Name,Last Name,Grade,Gender,Leader';
      const lines = rows.map((r) =>
        [r.firstName, r.lastName, r.grade ?? '', r.gender, r.leader]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      );
      return { csv: [header, ...lines].join('\n'), rowCount: rows.length };
    },

    async importAllocations(req: HttpRequest) {
      if (!req.ctx) throw new UnauthorizedError();
      const rows = (req.body as { rows?: unknown })?.rows;
      return deps.connection.importAllocations(req.ctx, rows);
    },
  };
}
