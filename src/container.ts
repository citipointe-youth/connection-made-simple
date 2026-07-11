import { join } from 'node:path';
import { env } from './config/env';
import { dedupeReads } from './utils/inflight-dedupe';

import {
  InMemoryUserRepository,
  InMemoryStudentRepository,
  InMemoryLeaderRepository,
  InMemoryConnectionRepository,
  InMemoryServiceSessionRepository,
  InMemoryServiceAttendanceRepository,
  InMemoryLifegroupRepository,
  InMemoryLifegroupWeekRepository,
  InMemoryLifegroupAttendanceRepository,
  InMemoryImportRepository,
  InMemorySettingsRepository,
  InMemoryAuditRepository,
  InMemoryConnectionAuditRepository,
} from './repositories/in-memory';
import { JsonFilePersistence } from './repositories/persistence';
import {
  SupabaseUserRepository,
  SupabaseStudentRepository,
  SupabaseLeaderRepository,
  SupabaseConnectionRepository,
  SupabaseServiceSessionRepository,
  SupabaseServiceAttendanceRepository,
  SupabaseLifegroupRepository,
  SupabaseLifegroupWeekRepository,
  SupabaseLifegroupAttendanceRepository,
  SupabaseImportRepository,
  SupabaseSettingsRepository,
  SupabaseAuditRepository,
  SupabaseConnectionAuditRepository,
  getSqlClient,
} from './repositories/supabase/index';

import type {
  IUserRepository,
  IStudentRepository,
  ILeaderRepository,
  IConnectionRepository,
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ILifegroupRepository,
  ILifegroupWeekRepository,
  ILifegroupAttendanceRepository,
  IImportRepository,
  ISettingsRepository,
  IAuditRepository,
  IConnectionAuditRepository,
} from './repositories/interfaces';

import { makeAuthService, type AuthService } from './services/auth.service';
import { makeStudentService, type StudentService } from './services/student.service';
import { makeLeaderService, type LeaderService } from './services/leader.service';
import { makeConnectionService, type ConnectionService } from './services/connection.service';
import { makeFollowupService, type FollowupService } from './services/followup.service';
import { makeOverviewService, type OverviewService } from './services/overview.service';
import { makeAtRiskService, type AtRiskService } from './services/atrisk.service';
import { makeImportService, type ImportService } from './services/import.service';
import { makeSettingsService, type SettingsService } from './services/settings.service';
import { makeAccountService, type AccountService } from './services/account.service';
import { makeAdminService, type AdminService } from './services/admin.service';
import { makeTrendsService, type TrendsService } from './services/trends.service';
import { makeLifegroupStatsService, type LifegroupStatsService } from './services/lifegroup-stats.service';
import { makeConnectionAuditService, type ConnectionAuditService } from './services/connection-audit.service';

export interface Repositories {
  users: IUserRepository;
  students: IStudentRepository;
  leaders: ILeaderRepository;
  connections: IConnectionRepository;
  serviceSessions: IServiceSessionRepository;
  serviceAttendance: IServiceAttendanceRepository;
  lifegroups: ILifegroupRepository;
  lifegroupWeeks: ILifegroupWeekRepository;
  lifegroupAttendance: ILifegroupAttendanceRepository;
  imports: IImportRepository;
  settings: ISettingsRepository;
  audit: IAuditRepository;
  connectionAudits: IConnectionAuditRepository;
}

export interface Services {
  auth: AuthService;
  student: StudentService;
  leader: LeaderService;
  connection: ConnectionService;
  followup: FollowupService;
  overview: OverviewService;
  atRisk: AtRiskService;
  trends: TrendsService;
  lifegroupStats: LifegroupStatsService;
  importService: ImportService;
  settings: SettingsService;
  account: AccountService;
  admin: AdminService;
  connectionAudit: ConnectionAuditService;
  users: IUserRepository;
}

export interface Container {
  repos: Repositories;
  services: Services;
}

function makeJson<T>(filename: string): JsonFilePersistence<T> {
  return new JsonFilePersistence<T>(join(env.DATA_DIR, filename));
}

export async function buildContainer(): Promise<Container> {
  const useSupabase = env.PERSISTENCE === 'supabase';
  const useJson = env.PERSISTENCE === 'json';
  const sql = useSupabase ? getSqlClient() : null!;

  // ----- Repositories -----
  const users: IUserRepository = useSupabase
    ? new SupabaseUserRepository(sql)
    : new InMemoryUserRepository(useJson ? makeJson('users.json') : undefined);
  const students: IStudentRepository = useSupabase
    ? new SupabaseStudentRepository(sql)
    : new InMemoryStudentRepository(useJson ? makeJson('students.json') : undefined);
  const leaders: ILeaderRepository = useSupabase
    ? new SupabaseLeaderRepository(sql)
    : new InMemoryLeaderRepository(useJson ? makeJson('leaders.json') : undefined);
  const connections: IConnectionRepository = useSupabase
    ? new SupabaseConnectionRepository(sql)
    : new InMemoryConnectionRepository(useJson ? makeJson('connections.json') : undefined);
  const serviceSessions: IServiceSessionRepository = useSupabase
    ? new SupabaseServiceSessionRepository(sql)
    : new InMemoryServiceSessionRepository(useJson ? makeJson('service-sessions.json') : undefined);
  const serviceAttendance: IServiceAttendanceRepository = useSupabase
    ? new SupabaseServiceAttendanceRepository(sql)
    : new InMemoryServiceAttendanceRepository(useJson ? makeJson('service-attendance.json') : undefined);
  const lifegroups: ILifegroupRepository = useSupabase
    ? new SupabaseLifegroupRepository(sql)
    : new InMemoryLifegroupRepository(useJson ? makeJson('lifegroups.json') : undefined);
  const lifegroupWeeks: ILifegroupWeekRepository = useSupabase
    ? new SupabaseLifegroupWeekRepository(sql)
    : new InMemoryLifegroupWeekRepository(useJson ? makeJson('lifegroup-weeks.json') : undefined);
  const lifegroupAttendance: ILifegroupAttendanceRepository = useSupabase
    ? new SupabaseLifegroupAttendanceRepository(sql)
    : new InMemoryLifegroupAttendanceRepository(useJson ? makeJson('lifegroup-attendance.json') : undefined);
  const imports: IImportRepository = useSupabase
    ? new SupabaseImportRepository(sql)
    : new InMemoryImportRepository(useJson ? makeJson('imports.json') : undefined);
  const settings: ISettingsRepository = useSupabase
    ? new SupabaseSettingsRepository(sql)
    : new InMemorySettingsRepository(useJson ? makeJson('settings.json') : undefined);
  const audit: IAuditRepository = useSupabase
    ? new SupabaseAuditRepository(sql)
    : new InMemoryAuditRepository(useJson ? makeJson('audit.json') : undefined);
  const connectionAudits: IConnectionAuditRepository = useSupabase
    ? new SupabaseConnectionAuditRepository(sql)
    : new InMemoryConnectionAuditRepository(useJson ? makeJson('connection-audits.json') : undefined);

  // Home/Trends fan out to several endpoints in parallel that each independently
  // re-fetch the same full tables (e.g. studentRepo.findAll() runs 4x for one Home
  // load). Coalesce concurrent callers of these no-arg reads into a single query —
  // safe because none of them vary by caller; actor-scoping happens in the service
  // layer after the fetch. Supabase-only: in-memory repos (tests) are already
  // instant and don't need it.
  if (useSupabase) {
    dedupeReads(students, 'students', ['findAll']);
    dedupeReads(leaders, 'leaders', ['findActive']);
    dedupeReads(connections, 'connections', ['findAll']);
    dedupeReads(serviceSessions, 'serviceSessions', ['findAll']);
    dedupeReads(lifegroups, 'lifegroups', ['findAll']);
    dedupeReads(lifegroupWeeks, 'lifegroupWeeks', ['findAll']);
    dedupeReads(lifegroupAttendance, 'lifegroupAttendance', ['findAll']);
    dedupeReads(settings, 'settings', ['getSettings']);
  }

  const repos: Repositories = {
    users, students, leaders, connections,
    serviceSessions, serviceAttendance,
    lifegroups, lifegroupWeeks, lifegroupAttendance,
    imports, settings, audit, connectionAudits,
  };

  // Init all repos
  await Promise.all([
    users.init(), students.init(), leaders.init(), connections.init(),
    serviceSessions.init(), serviceAttendance.init(),
    lifegroups.init(), lifegroupWeeks.init(), lifegroupAttendance.init(),
    imports.init(), settings.init(), audit.init(), connectionAudits.init(),
  ]);

  // ----- Services -----
  const auth = makeAuthService(users);
  const student = makeStudentService(students, settings, connections);
  const leader = makeLeaderService(leaders);
  const connection = makeConnectionService(connections, students, leaders, settings);
  const followup = makeFollowupService(
    connections, students, leaders,
    serviceSessions, serviceAttendance,
    lifegroupWeeks, lifegroupAttendance,
  );
  const overview = makeOverviewService(students, leaders, connections, settings);
  const atRisk = makeAtRiskService(students, settings, connections);
  const trends = makeTrendsService(students, serviceSessions, serviceAttendance, settings);
  const lifegroupStats = makeLifegroupStatsService(students, lifegroups, lifegroupWeeks, lifegroupAttendance, serviceSessions, settings);
  const importService = makeImportService(students, serviceSessions, serviceAttendance, imports, settings, lifegroups, lifegroupWeeks, lifegroupAttendance, leaders, useSupabase ? sql : null);
  const settingsSvc = makeSettingsService(settings, audit);
  const account = makeAccountService(users);
  const admin = makeAdminService(
    students, leaders, connections,
    serviceSessions, serviceAttendance,
    lifegroups, lifegroupWeeks, lifegroupAttendance,
    imports, audit, connectionAudits,
  );
  const connectionAudit = makeConnectionAuditService(connectionAudits, settings);

  const services: Services = {
    auth, student, leader, connection, followup, overview, atRisk, trends, lifegroupStats,
    importService, settings: settingsSvc, account, admin, connectionAudit,
    users,
  };

  return { repos, services };
}
