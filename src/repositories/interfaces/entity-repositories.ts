import type { IRepository } from './base.repository';
import type { User } from '../../core/entities/user';
import type { Student } from '../../core/entities/student';
import type { Leader } from '../../core/entities/leader';
import type { PrayerRequest } from '../../core/entities/prayer';
import type { Connection } from '../../core/entities/connection';
import type {
  ServiceSession,
  ServiceAttendance,
  Lifegroup,
  LifegroupWeek,
  LifegroupAttendance,
  ImportRecord,
} from '../../core/entities/attendance';
import type { AppSettings, AdminAuditEntry } from '../../core/entities/settings';
import type { ConnectionAudit } from '../../core/entities/connection-audit';
import type { UserRole } from '../../core/types/enums';

export interface IUserRepository extends IRepository<User> {
  findByEmail(email: string): Promise<User | null>;
  findByRole(role: UserRole): Promise<User[]>;
}

export interface IStudentRepository extends IRepository<Student> {
  findByGrade(grade: number): Promise<Student[]>;
  findByGender(gender: string): Promise<Student[]>;
  search(query: string): Promise<Student[]>;
  saveMany(students: Student[]): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface ILeaderRepository extends IRepository<Leader> {
  findByGrade(grade: number): Promise<Leader[]>;
  findActive(): Promise<Leader[]>;
  saveMany(leaders: Leader[]): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface IPrayerRepository extends IRepository<PrayerRequest> {
  findByStudent(studentId: string): Promise<PrayerRequest[]>;
  deleteAll(): Promise<void>;
}

export interface IConnectionRepository extends IRepository<Connection> {
  findByStudent(studentId: string): Promise<Connection[]>;
  findByLeader(leaderId: string): Promise<Connection[]>;
  findByStudentAndLeader(studentId: string, leaderId: string): Promise<Connection | null>;
  deleteByStudentAndLeader(studentId: string, leaderId: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface IServiceSessionRepository extends IRepository<ServiceSession> {
  findByImport(importId: string): Promise<ServiceSession[]>;
  findValid(): Promise<ServiceSession[]>;
  saveMany(sessions: ServiceSession[]): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface IServiceAttendanceRepository {
  init(): Promise<void>;
  findByStudent(studentId: string): Promise<ServiceAttendance[]>;
  findBySession(sessionId: string): Promise<ServiceAttendance[]>;
  save(record: ServiceAttendance): Promise<ServiceAttendance>;
  saveMany(records: ServiceAttendance[]): Promise<void>;
  deleteByImport(importId: string): Promise<void>;
  deleteAll(): Promise<void>;
  findAll(): Promise<ServiceAttendance[]>;
}

export interface ILifegroupRepository extends IRepository<Lifegroup> {
  saveMany(lifegroups: Lifegroup[]): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface ILifegroupWeekRepository extends IRepository<LifegroupWeek> {
  findByImport(importId: string): Promise<LifegroupWeek[]>;
  saveMany(weeks: LifegroupWeek[]): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface ILifegroupAttendanceRepository {
  init(): Promise<void>;
  findByStudent(studentId: string): Promise<LifegroupAttendance[]>;
  findByWeek(weekId: string): Promise<LifegroupAttendance[]>;
  saveMany(records: LifegroupAttendance[]): Promise<void>;
  deleteByImport(importId: string): Promise<void>;
  deleteAll(): Promise<void>;
  findAll(): Promise<LifegroupAttendance[]>;
}

export interface IImportRepository extends IRepository<ImportRecord> {
  findByType(type: 'service' | 'lifegroup'): Promise<ImportRecord[]>;
  deleteAll(): Promise<void>;
}

export interface ISettingsRepository extends IRepository<AppSettings> {
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export interface IAuditRepository extends IRepository<AdminAuditEntry> {
  findRecent(limit: number): Promise<AdminAuditEntry[]>;
}

export interface IConnectionAuditRepository extends IRepository<ConnectionAudit> {
  findByYear(year: number): Promise<ConnectionAudit | null>;
}

