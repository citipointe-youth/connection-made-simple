import type { Route } from './types';
import type { Services } from '../../container';
import { makeAuthController } from '../controllers/auth.controller';
import { makeStudentController } from '../controllers/student.controller';
import { makeLeaderController } from '../controllers/leader.controller';
import { makeConnectionController } from '../controllers/connection.controller';
import { makeFollowupController } from '../controllers/followup.controller';
import { makeOverviewController } from '../controllers/overview.controller';
import { makeAtRiskController } from '../controllers/atrisk.controller';
import { makeImportController } from '../controllers/import.controller';
import { makeSettingsController } from '../controllers/settings.controller';
import { makeAccountController } from '../controllers/account.controller';
import { makeAdminController } from '../controllers/admin.controller';
import { makeTrendsController } from '../controllers/trends.controller';
import { makeLifegroupStatsController } from '../controllers/lifegroup-stats.controller';
import { makePushController } from '../controllers/push.controller';
import { makeConnectionAuditController } from '../controllers/connection-audit.controller';
import { makeBatchController } from '../controllers/batch.controller';

export function buildRoutes(services: Services): Route[] {
  const auth = makeAuthController({ auth: services.auth, users: services.users });
  const student = makeStudentController({ student: services.student });
  const leader = makeLeaderController({ leader: services.leader });
  const connection = makeConnectionController({ connection: services.connection });
  const followup = makeFollowupController({ followup: services.followup });
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
  const lifegroupStats = makeLifegroupStatsController({ lifegroupStats: services.lifegroupStats });
  const push = makePushController({ push: services.push });
  const connectionAudit = makeConnectionAuditController({ connectionAudit: services.connectionAudit });
  const batch = makeBatchController({
    overview: services.overview,
    trends: services.trends,
    student: services.student,
    lifegroupStats: services.lifegroupStats,
    connection: services.connection,
    atRisk: services.atRisk,
    settings: services.settings,
    leader: services.leader,
  });

  return [
    // ----- Batch (compose several read endpoints into one request; see batch.controller) -----
    { method: 'GET', path: '/batch', auth: true, handler: (r) => batch.get(r) },

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
    { method: 'PATCH',  path: '/leaders/:id/sms-template', auth: true, handler: (r) => leader.updateSmsTemplate(r) },

    // ----- Connections -----
    { method: 'GET',    path: '/connections',                          auth: true, handler: (r) => connection.listAll(r) },
    { method: 'POST',   path: '/connections',                          auth: true, handler: (r) => connection.assign(r) },
    { method: 'GET',    path: '/connections/export',                   auth: true, handler: (r) => connection.exportCsv(r) },
    { method: 'GET',  path: '/connections/allocations/export', auth: true, handler: (r) => connection.exportAllocations(r) },
    { method: 'POST', path: '/connections/allocations/import', auth: true, handler: (r) => connection.importAllocations(r) },
    { method: 'GET',    path: '/connections/student/:studentId',       auth: true, handler: (r) => connection.listByStudent(r) },
    { method: 'GET',    path: '/connections/leader/:leaderId',         auth: true, handler: (r) => connection.listByLeader(r) },
    { method: 'GET',    path: '/connections/leader/:leaderId/summary', auth: true, handler: (r) => connection.leaderSummary(r) },
    { method: 'GET',    path: '/connections/leader/:leaderId/followup', auth: true, handler: (r) => followup.leaderFollowup(r) },
    { method: 'DELETE', path: '/connections/:studentId/:leaderId',     auth: true, handler: (r) => connection.unassign(r) },

    // ----- At-Risk -----
    { method: 'GET',  path: '/at-risk',           auth: true, handler: (r) => atRisk.list(r) },
    { method: 'POST', path: '/at-risk/recompute', auth: true, handler: (r) => atRisk.recompute(r) },

    // ----- Trends -----
    { method: 'GET', path: '/trends', auth: true, handler: (r) => trends.get(r) },
    { method: 'GET', path: '/lifegroups/stats', auth: true, handler: (r) => lifegroupStats.get(r) },

    // ----- Import -----
    { method: 'POST',   path: '/import/csv',          auth: true, handler: (r) => importCtrl.importCsv(r) },
    { method: 'POST',   path: '/import/group-csv',    auth: true, handler: (r) => importCtrl.importGroupCsv(r) },
    { method: 'GET',    path: '/import/history',      auth: true, handler: (r) => importCtrl.history(r) },
    { method: 'DELETE', path: '/import/history',      auth: true, handler: (r) => importCtrl.clearHistory(r) },
    { method: 'DELETE', path: '/import/history/:id',  auth: true, handler: (r) => importCtrl.deleteImport(r) },

    // ----- Admin -----
    { method: 'POST', path: '/admin/reset',         auth: true, handler: (r) => admin.reset(r) },
    { method: 'POST', path: '/admin/clear-service-group', auth: true, handler: (r) => admin.clearServiceGroupData(r) },
    { method: 'GET',  path: '/admin/audit',         auth: true, handler: (r) => admin.auditLog(r) },

    // ----- Push notifications -----
    { method: 'GET',    path: '/push/vapid-key',              auth: false, handler: (r) => push.getVapidKey(r) },
    { method: 'POST',   path: '/push/subscribe',              auth: true,  handler: (r) => push.subscribe(r) },
    { method: 'POST',   path: '/push/unsubscribe',            auth: true,  handler: (r) => push.unsubscribe(r) },
    { method: 'POST',   path: '/push/send',                   auth: true,  handler: (r) => push.send(r) },
    { method: 'GET',    path: '/push/notifications',          auth: true,  handler: (r) => push.getNotifications(r) },
    { method: 'DELETE', path: '/push/notifications/:id',      auth: true,  handler: (r) => push.deleteNotification(r) },
    { method: 'POST',   path: '/push/notifications/:id/dismiss', auth: true, handler: (r) => push.dismissNotification(r) },

    // ----- Account management -----
    { method: 'GET',    path: '/accounts/users',               auth: true, handler: (r) => account.list(r) },
    { method: 'POST',   path: '/accounts/users',               auth: true, handler: (r) => account.create(r) },
    { method: 'PATCH',  path: '/accounts/users/:id',           auth: true, handler: (r) => account.update(r) },
    { method: 'POST',   path: '/accounts/users/password',      auth: true, handler: (r) => account.setPassword(r) },
    { method: 'POST',   path: '/accounts/me/password',         auth: true, handler: (r) => account.changeOwnPassword(r) },
    { method: 'PATCH',  path: '/accounts/users/:id/status',    auth: true, handler: (r) => account.toggleStatus(r) },
    { method: 'DELETE', path: '/accounts/users/:id',           auth: true, handler: (r) => account.remove(r) },

    // ----- Connection Audits -----
    // NOTE: static /audits/* sub-paths (export-all, finalize-live) MUST be
    // registered before the /audits/:year param routes below — Express matches
    // routes in registration order, and :year would otherwise swallow them.
    { method: 'POST',   path: '/audits',       auth: true, handler: (r) => connectionAudit.upload(r) },
    { method: 'GET',    path: '/audits',       auth: true, handler: (r) => connectionAudit.list(r) },
    { method: 'POST',   path: '/audits/finalize-live', auth: true, handler: (r) => connectionAudit.finalizeFromLive(r) },
    { method: 'GET',    path: '/audits/export-all', auth: true, handler: (r) => connectionAudit.exportAll(r) },
    { method: 'POST',   path: '/audits/import-all', auth: true, handler: (r) => connectionAudit.importAll(r) },
    { method: 'GET',    path: '/audits/:year', auth: true, handler: (r) => connectionAudit.get(r) },
    { method: 'DELETE', path: '/audits/:year', auth: true, handler: (r) => connectionAudit.remove(r) },
  ];
}
