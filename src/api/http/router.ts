import type { Route } from './types';
import type { Services } from '../../container';
import { makeAuthController } from '../controllers/auth.controller';
import { makeStudentController } from '../controllers/student.controller';
import { makeLeaderController } from '../controllers/leader.controller';
import { makeConnectionController } from '../controllers/connection.controller';
import { makeOverviewController } from '../controllers/overview.controller';
import { makeAtRiskController } from '../controllers/atrisk.controller';
import { makeImportController } from '../controllers/import.controller';
import { makeSettingsController } from '../controllers/settings.controller';
import { makeAccountController } from '../controllers/account.controller';
import { makeAdminController } from '../controllers/admin.controller';
import { makeTrendsController } from '../controllers/trends.controller';

export function buildRoutes(services: Services): Route[] {
  const auth = makeAuthController({ auth: services.auth, users: services.users });
  const student = makeStudentController({ student: services.student });
  const leader = makeLeaderController({ leader: services.leader });
  const connection = makeConnectionController({ connection: services.connection });
  const overview = makeOverviewController({ overview: services.overview });
  const atRisk = makeAtRiskController({
    atRisk: services.atRisk,
    importService: services.importService,
    student: services.student,
  });
  const importCtrl = makeImportController({ importService: services.importService });
  const settings = makeSettingsController({ settings: services.settings });
  const account = makeAccountController({ account: services.account });
  const admin = makeAdminController({ admin: services.admin });
  const trends = makeTrendsController({ trends: services.trends });

  return [
    // ----- Auth -----
    { method: 'POST', path: '/auth/login',  auth: false, handler: (r) => auth.login(r) },
    { method: 'GET',  path: '/auth/me',     auth: true,  handler: (r) => auth.me(r) },
    { method: 'POST', path: '/auth/logout', auth: true,  handler: (r) => auth.logout(r) },

    // ----- Overview -----
    { method: 'GET', path: '/overview', auth: true, handler: (r) => overview.stats(r) },

    // ----- Settings -----
    { method: 'GET',   path: '/settings', auth: false, handler: (r) => settings.get(r) },
    { method: 'PATCH', path: '/settings', auth: true,  handler: (r) => settings.update(r) },

    // ----- Students -----
    { method: 'GET',    path: '/students',                    auth: true, handler: (r) => student.list(r) },
    { method: 'POST',   path: '/students',                    auth: true, handler: (r) => student.create(r) },
    { method: 'GET',    path: '/students/search',             auth: true, handler: (r) => student.search(r) },
    { method: 'GET',    path: '/students/:id',                auth: true, handler: (r) => student.get(r) },
    { method: 'PATCH',  path: '/students/:id',                auth: true, handler: (r) => student.update(r) },
    { method: 'PATCH',  path: '/students/:id/at-risk',        auth: true, handler: (r) => student.updateAtRisk(r) },
    { method: 'DELETE', path: '/students/:id',                auth: true, handler: (r) => student.remove(r) },

    // ----- Leaders -----
    { method: 'GET',    path: '/leaders',     auth: true, handler: (r) => leader.list(r) },
    { method: 'POST',   path: '/leaders',     auth: true, handler: (r) => leader.create(r) },
    { method: 'GET',    path: '/leaders/:id', auth: true, handler: (r) => leader.get(r) },
    { method: 'PATCH',  path: '/leaders/:id', auth: true, handler: (r) => leader.update(r) },
    { method: 'DELETE', path: '/leaders/:id', auth: true, handler: (r) => leader.remove(r) },

    // ----- Connections -----
    { method: 'GET',    path: '/connections',                          auth: true, handler: (r) => connection.listAll(r) },
    { method: 'POST',   path: '/connections',                          auth: true, handler: (r) => connection.assign(r) },
    { method: 'GET',    path: '/connections/export',                   auth: true, handler: (r) => connection.exportCsv(r) },
    { method: 'GET',    path: '/connections/student/:studentId',       auth: true, handler: (r) => connection.listByStudent(r) },
    { method: 'GET',    path: '/connections/leader/:leaderId',         auth: true, handler: (r) => connection.listByLeader(r) },
    { method: 'GET',    path: '/connections/leader/:leaderId/summary', auth: true, handler: (r) => connection.leaderSummary(r) },
    { method: 'DELETE', path: '/connections/:studentId/:leaderId',     auth: true, handler: (r) => connection.unassign(r) },

    // ----- At-Risk -----
    { method: 'GET',  path: '/at-risk',           auth: true, handler: (r) => atRisk.list(r) },
    { method: 'POST', path: '/at-risk/recompute', auth: true, handler: (r) => atRisk.recompute(r) },

    // ----- Trends -----
    { method: 'GET', path: '/trends', auth: true, handler: (r) => trends.get(r) },

    // ----- Import -----
    { method: 'POST',   path: '/import/csv',          auth: true, handler: (r) => importCtrl.importCsv(r) },
    { method: 'POST',   path: '/import/group-csv',    auth: true, handler: (r) => importCtrl.importGroupCsv(r) },
    { method: 'GET',    path: '/import/history',      auth: true, handler: (r) => importCtrl.history(r) },
    { method: 'DELETE', path: '/import/history',      auth: true, handler: (r) => importCtrl.clearHistory(r) },
    { method: 'DELETE', path: '/import/history/:id',  auth: true, handler: (r) => importCtrl.deleteImport(r) },

    // ----- Admin -----
    { method: 'POST', path: '/admin/reset',         auth: true, handler: (r) => admin.reset(r) },
    { method: 'POST', path: '/admin/save-defaults', auth: true, handler: (r) => admin.saveDefaults(r) },
    { method: 'POST', path: '/admin/new-year',      auth: true, handler: (r) => admin.newYear(r) },
    { method: 'GET',  path: '/admin/audit',         auth: true, handler: (r) => admin.auditLog(r) },

    // ----- Account management -----
    { method: 'GET',    path: '/accounts/users',               auth: true, handler: (r) => account.list(r) },
    { method: 'POST',   path: '/accounts/users',               auth: true, handler: (r) => account.create(r) },
    { method: 'PATCH',  path: '/accounts/users/:id',           auth: true, handler: (r) => account.update(r) },
    { method: 'POST',   path: '/accounts/users/password',      auth: true, handler: (r) => account.setPassword(r) },
    { method: 'PATCH',  path: '/accounts/users/:id/status',    auth: true, handler: (r) => account.toggleStatus(r) },
    { method: 'DELETE', path: '/accounts/users/:id',           auth: true, handler: (r) => account.remove(r) },
  ];
}
