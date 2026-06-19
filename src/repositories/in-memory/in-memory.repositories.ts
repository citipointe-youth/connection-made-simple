import { InMemoryBaseRepository } from './in-memory.base.repository';
import type { IPersistenceAdapter } from '../persistence/persistence';
import { generateId } from '../../utils/id';

import type { User } from '../../core/entities/user';
import type { PushSubscription } from '../../core/entities/push-subscription';
import type { Notification, NotificationRecipient, NotificationWithRecipient } from '../../core/entities/notification';
import type { Student } from '../../core/entities/student';
import type { Leader } from '../../core/entities/leader';
import type { Connection } from '../../core/entities/connection';
import type {
  ServiceSession,
  ServiceAttendance,
  Lifegroup,
  LifegroupWeek,
  LifegroupAttendance,
  ImportRecord,
} from '../../core/entities/attendance';
import type { AppSettings, AppDefaults, AdminAuditEntry } from '../../core/entities/settings';
import type { UserRole } from '../../core/types/enums';

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
  ISnapshotRepository,
  IAuditRepository,
  IPushSubscriptionRepository,
  INotificationRepository,
} from '../interfaces/entity-repositories';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export class InMemoryUserRepository
  extends InMemoryBaseRepository<User>
  implements IUserRepository
{
  constructor(persistence?: IPersistenceAdapter<User>) { super(persistence); }

  async findByEmail(email: string): Promise<User | null> {
    const lower = email.toLowerCase();
    for (const user of this.store.values()) {
      if (user.email.toLowerCase() === lower) return this.clone(user);
    }
    return null;
  }

  async findByRole(role: UserRole): Promise<User[]> {
    return Array.from(this.store.values())
      .filter((u) => u.role === role)
      .map((u) => this.clone(u));
  }
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------
export class InMemoryStudentRepository
  extends InMemoryBaseRepository<Student>
  implements IStudentRepository
{
  constructor(persistence?: IPersistenceAdapter<Student>) { super(persistence); }

  async findByGrade(grade: number): Promise<Student[]> {
    return Array.from(this.store.values())
      .filter((s) => s.grade === grade)
      .map((s) => this.clone(s));
  }

  async findByGender(gender: string): Promise<Student[]> {
    return Array.from(this.store.values())
      .filter((s) => s.gender.toLowerCase() === gender.toLowerCase())
      .map((s) => this.clone(s));
  }

  async search(query: string): Promise<Student[]> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return Array.from(this.store.values())
      .filter((s) => {
        const full = `${s.firstName} ${s.lastName}`.toLowerCase();
        return terms.every((t) => full.includes(t));
      })
      .sort((a, b) => a.lastName.localeCompare(b.lastName))
      .slice(0, 50)
      .map((s) => this.clone(s));
  }

  async saveMany(students: Student[]): Promise<void> {
    for (const s of students) this.store.set(s.id, this.clone(s));
    await this.writeToPersistence();
  }
}

// ---------------------------------------------------------------------------
// Leaders
// ---------------------------------------------------------------------------
export class InMemoryLeaderRepository
  extends InMemoryBaseRepository<Leader>
  implements ILeaderRepository
{
  constructor(persistence?: IPersistenceAdapter<Leader>) { super(persistence); }

  async findByGrade(grade: number): Promise<Leader[]> {
    return Array.from(this.store.values())
      .filter((l) => l.active && (l.grades.length === 0 || l.grades.includes(grade as any)))
      .map((l) => this.clone(l));
  }

  async findActive(): Promise<Leader[]> {
    return Array.from(this.store.values())
      .filter((l) => l.active)
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((l) => this.clone(l));
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
export class InMemoryConnectionRepository
  extends InMemoryBaseRepository<Connection>
  implements IConnectionRepository
{
  constructor(persistence?: IPersistenceAdapter<Connection>) { super(persistence); }

  async findByStudent(studentId: string): Promise<Connection[]> {
    return Array.from(this.store.values())
      .filter((a) => a.studentId === studentId)
      .map((a) => this.clone(a));
  }

  async findByLeader(leaderId: string): Promise<Connection[]> {
    return Array.from(this.store.values())
      .filter((a) => a.leaderId === leaderId)
      .map((a) => this.clone(a));
  }

  async findByStudentAndLeader(studentId: string, leaderId: string): Promise<Connection | null> {
    for (const a of this.store.values()) {
      if (a.studentId === studentId && a.leaderId === leaderId) return this.clone(a);
    }
    return null;
  }

  async deleteByStudentAndLeader(studentId: string, leaderId: string): Promise<boolean> {
    for (const [id, a] of this.store.entries()) {
      if (a.studentId === studentId && a.leaderId === leaderId) {
        this.store.delete(id);
        await this.writeToPersistence();
        return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Service Sessions
// ---------------------------------------------------------------------------
export class InMemoryServiceSessionRepository
  extends InMemoryBaseRepository<ServiceSession>
  implements IServiceSessionRepository
{
  constructor(persistence?: IPersistenceAdapter<ServiceSession>) { super(persistence); }

  async findByImport(importId: string): Promise<ServiceSession[]> {
    return Array.from(this.store.values())
      .filter((s) => s.importId === importId)
      .map((s) => this.clone(s));
  }

  async findValid(): Promise<ServiceSession[]> {
    return Array.from(this.store.values())
      .filter((s) => s.isValid && s.isRegular)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => this.clone(s));
  }

  async saveMany(sessions: ServiceSession[]): Promise<void> {
    for (const s of sessions) this.store.set(s.id, this.clone(s));
    await this.writeToPersistence();
  }
}

// ---------------------------------------------------------------------------
// Service Attendance
// ---------------------------------------------------------------------------
export class InMemoryServiceAttendanceRepository
  implements IServiceAttendanceRepository
{
  private store: ServiceAttendance[] = [];
  private persistence;

  constructor(persistence?: IPersistenceAdapter<ServiceAttendance>) {
    this.persistence = persistence ?? { read: async () => [], write: async () => {} };
  }

  async init(): Promise<void> {
    this.store = await this.persistence.read();
  }

  async findAll(): Promise<ServiceAttendance[]> {
    return [...this.store];
  }

  async findByStudent(studentId: string): Promise<ServiceAttendance[]> {
    return this.store.filter((r) => r.studentId === studentId);
  }

  async findBySession(sessionId: string): Promise<ServiceAttendance[]> {
    return this.store.filter((r) => r.sessionId === sessionId);
  }

  async save(record: ServiceAttendance): Promise<ServiceAttendance> {
    const idx = this.store.findIndex(
      (r) => r.studentId === record.studentId && r.sessionId === record.sessionId,
    );
    if (idx >= 0) this.store[idx] = record;
    else this.store.push(record);
    await this.persistence.write(this.store);
    return { ...record };
  }

  async saveMany(records: ServiceAttendance[]): Promise<void> {
    for (const r of records) {
      const idx = this.store.findIndex(
        (x) => x.studentId === r.studentId && x.sessionId === r.sessionId,
      );
      if (idx >= 0) this.store[idx] = r;
      else this.store.push(r);
    }
    await this.persistence.write(this.store);
  }

  async deleteByImport(importId: string): Promise<void> {
    this.store = this.store.filter((r) => !r.sessionId.startsWith(importId));
    await this.persistence.write(this.store);
  }

  async deleteAll(): Promise<void> {
    this.store = [];
    await this.persistence.write(this.store);
  }
}

// ---------------------------------------------------------------------------
// Lifegroups
// ---------------------------------------------------------------------------
export class InMemoryLifegroupRepository
  extends InMemoryBaseRepository<Lifegroup>
  implements ILifegroupRepository
{
  constructor(persistence?: IPersistenceAdapter<Lifegroup>) { super(persistence); }

  async saveMany(lifegroups: Lifegroup[]): Promise<void> {
    for (const g of lifegroups) this.store.set(g.id, this.clone(g));
    await this.writeToPersistence();
  }
}

// ---------------------------------------------------------------------------
// Lifegroup Weeks
// ---------------------------------------------------------------------------
export class InMemoryLifegroupWeekRepository
  extends InMemoryBaseRepository<LifegroupWeek>
  implements ILifegroupWeekRepository
{
  constructor(persistence?: IPersistenceAdapter<LifegroupWeek>) { super(persistence); }

  async findByImport(importId: string): Promise<LifegroupWeek[]> {
    return Array.from(this.store.values())
      .filter((w) => w.importId === importId)
      .map((w) => this.clone(w));
  }

  async saveMany(weeks: LifegroupWeek[]): Promise<void> {
    for (const w of weeks) this.store.set(w.id, this.clone(w));
    await this.writeToPersistence();
  }
}

// ---------------------------------------------------------------------------
// Lifegroup Attendance
// ---------------------------------------------------------------------------
export class InMemoryLifegroupAttendanceRepository
  implements ILifegroupAttendanceRepository
{
  private store: LifegroupAttendance[] = [];
  private persistence;

  constructor(persistence?: IPersistenceAdapter<LifegroupAttendance>) {
    this.persistence = persistence ?? { read: async () => [], write: async () => {} };
  }

  async init(): Promise<void> {
    this.store = await this.persistence.read();
  }

  async findAll(): Promise<LifegroupAttendance[]> {
    return [...this.store];
  }

  async findByStudent(studentId: string): Promise<LifegroupAttendance[]> {
    return this.store.filter((r) => r.studentId === studentId);
  }

  async findByWeek(weekId: string): Promise<LifegroupAttendance[]> {
    return this.store.filter((r) => r.weekId === weekId);
  }

  async saveMany(records: LifegroupAttendance[]): Promise<void> {
    for (const r of records) {
      const idx = this.store.findIndex(
        (x) => x.studentId === r.studentId && x.weekId === r.weekId && x.lifegroupId === r.lifegroupId,
      );
      if (idx >= 0) this.store[idx] = r;
      else this.store.push(r);
    }
    await this.persistence.write(this.store);
  }

  async deleteByImport(_importId: string): Promise<void> {
    this.store = [];
    await this.persistence.write(this.store);
  }

  async deleteAll(): Promise<void> {
    this.store = [];
    await this.persistence.write(this.store);
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
export class InMemoryImportRepository
  extends InMemoryBaseRepository<ImportRecord>
  implements IImportRepository
{
  constructor(persistence?: IPersistenceAdapter<ImportRecord>) { super(persistence); }

  async findByType(type: 'service' | 'lifegroup'): Promise<ImportRecord[]> {
    return Array.from(this.store.values())
      .filter((r) => r.type === type)
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
      .map((r) => this.clone(r));
  }
}

// ---------------------------------------------------------------------------
// Settings (singleton-style)
// ---------------------------------------------------------------------------
export class InMemorySettingsRepository
  extends InMemoryBaseRepository<AppSettings>
  implements ISettingsRepository
{
  private static readonly SETTINGS_ID = 'global';

  constructor(persistence?: IPersistenceAdapter<AppSettings>) { super(persistence); }

  async getSettings(): Promise<AppSettings> {
    let s = await this.findById(InMemorySettingsRepository.SETTINGS_ID);
    if (!s) {
      s = this.defaultSettings();
      await this.save(s);
    }
    return s;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.getSettings();
    const updated: AppSettings = { ...current, ...patch, id: InMemorySettingsRepository.SETTINGS_ID };
    return this.save(updated);
  }

  private defaultSettings(): AppSettings {
    return {
      id: InMemorySettingsRepository.SETTINGS_ID,
      ministryName: 'Youth Ministry',
      termGapDays: 14,
      regRateNumerator: 3,
      regRateDenominator: 4,
      riskRateNumerator: 1,
      riskRateDenominator: 2,
      validThresholdPct: 25,
      serviceMinAttendance: 100,
      serviceName: 'Sunday Service',
      lifegroupName: 'Lifegroup',
      connectionLockDate: null,
      updatedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------
export class InMemorySnapshotRepository
  extends InMemoryBaseRepository<AppDefaults>
  implements ISnapshotRepository
{
  constructor(persistence?: IPersistenceAdapter<AppDefaults>) { super(persistence); }
}

// ---------------------------------------------------------------------------
// Admin Audit Log
// ---------------------------------------------------------------------------
export class InMemoryAuditRepository
  extends InMemoryBaseRepository<AdminAuditEntry>
  implements IAuditRepository
{
  constructor(persistence?: IPersistenceAdapter<AdminAuditEntry>) { super(persistence); }

  async findRecent(limit: number): Promise<AdminAuditEntry[]> {
    return Array.from(this.store.values())
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
      .slice(0, limit)
      .map((e) => this.clone(e));
  }
}

// ---------------------------------------------------------------------------
// Push Subscriptions
// ---------------------------------------------------------------------------
export class InMemoryPushSubscriptionRepository implements IPushSubscriptionRepository {
  private subs: PushSubscription[] = [];

  async init(): Promise<void> {}

  async findByUserId(userId: string): Promise<PushSubscription[]> {
    return this.subs.filter((s) => s.userId === userId).map((s) => ({ ...s }));
  }

  async findByUserIds(userIds: string[]): Promise<PushSubscription[]> {
    const set = new Set(userIds);
    return this.subs.filter((s) => set.has(s.userId)).map((s) => ({ ...s }));
  }

  async upsert(sub: PushSubscription): Promise<PushSubscription> {
    const idx = this.subs.findIndex(
      (s) => s.userId === sub.userId && s.endpoint === sub.endpoint,
    );
    if (idx >= 0) {
      this.subs[idx] = { ...sub };
    } else {
      this.subs.push({ ...sub });
    }
    return { ...sub };
  }

  async deleteByEndpoint(userId: string, endpoint: string): Promise<void> {
    this.subs = this.subs.filter(
      (s) => !(s.userId === userId && s.endpoint === endpoint),
    );
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.subs = this.subs.filter((s) => s.userId !== userId);
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export class InMemoryNotificationRepository implements INotificationRepository {
  private notifications: Notification[] = [];
  private recipients: NotificationRecipient[] = [];

  async init(): Promise<void> {}

  async save(notification: Notification): Promise<Notification> {
    const idx = this.notifications.findIndex((n) => n.id === notification.id);
    if (idx >= 0) {
      this.notifications[idx] = { ...notification };
    } else {
      this.notifications.push({ ...notification });
    }
    return { ...notification };
  }

  async saveRecipients(notificationId: string, recipientIds: string[]): Promise<void> {
    for (const recipientId of recipientIds) {
      const exists = this.recipients.some(
        (r) => r.notificationId === notificationId && r.recipientId === recipientId,
      );
      if (!exists) {
        this.recipients.push({ id: generateId(), notificationId, recipientId, dismissedAt: null });
      }
    }
  }

  async findById(id: string): Promise<Notification | null> {
    return this.notifications.find((n) => n.id === id) ?? null;
  }

  async findSentByUser(userId: string): Promise<Notification[]> {
    const now = new Date().toISOString();
    return this.notifications
      .filter((n) => n.senderId === userId && n.deletedAt === null && n.expiresAt > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((n) => ({ ...n }));
  }

  async findReceivedByUser(userId: string): Promise<NotificationWithRecipient[]> {
    const now = new Date().toISOString();
    return this.recipients
      .filter((r) => r.recipientId === userId && r.dismissedAt === null)
      .flatMap((r) => {
        const n = this.notifications.find((n) => n.id === r.notificationId);
        if (!n || n.deletedAt !== null || n.expiresAt <= now) return [];
        return [{ ...n, dismissedAt: r.dismissedAt }];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
  }

  async softDelete(id: string, deletedAt: string): Promise<void> {
    const n = this.notifications.find((n) => n.id === id);
    if (n) n.deletedAt = deletedAt;
  }

  async dismissForUser(notificationId: string, userId: string, dismissedAt: string): Promise<void> {
    const r = this.recipients.find(
      (r) => r.notificationId === notificationId && r.recipientId === userId,
    );
    if (r) r.dismissedAt = dismissedAt;
  }
}
