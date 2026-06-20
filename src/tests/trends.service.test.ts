import { describe, it, expect } from 'vitest';
import { makeTrendsService, invalidateTrendsCache } from '../services/trends.service';
import { makeStudentService } from '../services/student.service';
import { makeAtRiskService } from '../services/atrisk.service';
import {
  InMemoryStudentRepository,
  InMemorySettingsRepository,
  InMemoryServiceSessionRepository,
  InMemoryServiceAttendanceRepository,
} from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';

function actor(role: string, opts: { grade?: number; quad?: string } = {}): Actor {
  return { id: 'a-test', role: role as any, displayName: 'T', grade: (opts.grade ?? null) as any, quad: (opts.quad ?? null) as any };
}

const ADMIN = actor('admin');

async function makeServices() {
  // The trends service keeps a module-level response cache keyed by actor. Each
  // test builds fresh repositories, so clear that cache to avoid one test's
  // result leaking into another via a shared actor key (e.g. ADMIN).
  invalidateTrendsCache();
  const studentRepo = new InMemoryStudentRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const sessionRepo = new InMemoryServiceSessionRepository();
  const attendanceRepo = new InMemoryServiceAttendanceRepository();
  await Promise.all([studentRepo.init(), settingsRepo.init(), sessionRepo.init(), attendanceRepo.init()]);
  // Tiny dataset: any session with >=1 attendee counts as valid (prod default 100).
  await settingsRepo.updateSettings({ serviceMinAttendance: 1 });

  const studentSvc = makeStudentService(studentRepo);
  const atRiskSvc = makeAtRiskService(studentRepo, settingsRepo);
  const trendsSvc = makeTrendsService(studentRepo, sessionRepo, attendanceRepo, settingsRepo);

  // Seed 2 students
  const s1 = await studentSvc.create(ADMIN, { firstName: 'Alice', lastName: 'Smith', gender: 'female', grade: 9 });
  const s2 = await studentSvc.create(ADMIN, { firstName: 'Bob', lastName: 'Jones', gender: 'male', grade: 9 });

  // Seed 3 sessions
  const sessions = ['2024-02-04', '2024-02-11', '2024-02-18'].map((date, i) => ({
    id: `sess-${i}`, importId: 'imp1', sessionDate: date, sessionName: date,
    isRegular: true, isValid: true, totalAttendance: 0, sortOrder: i, createdAt: '2024-02-18T00:00:00Z',
  }));
  for (const sess of sessions) await sessionRepo.save(sess);

  // Alice attends all 3; Bob attends 1
  await attendanceRepo.saveMany([
    { studentId: s1.id, sessionId: 'sess-0', attended: true },
    { studentId: s1.id, sessionId: 'sess-1', attended: true },
    { studentId: s1.id, sessionId: 'sess-2', attended: true },
    { studentId: s2.id, sessionId: 'sess-0', attended: false },
    { studentId: s2.id, sessionId: 'sess-1', attended: false },
    { studentId: s2.id, sessionId: 'sess-2', attended: true },
  ]);

  return { studentSvc, atRiskSvc, trendsSvc, studentRepo, settingsRepo, s1, s2 };
}

describe('Trends Service', () => {
  // TC48 — trends endpoint returns session-level data
  it('TC48: trends returns one point per session', async () => {
    const { trendsSvc } = await makeServices();
    const data = await trendsSvc.get(ADMIN);
    expect(data.ministry.sessions).toHaveLength(3);
  });

  // TC49 — ministry average is computed correctly (Alice=3, Bob=1, avg=2)
  it('TC49: ministry average attendance is correct', async () => {
    const { trendsSvc } = await makeServices();
    const data = await trendsSvc.get(ADMIN);
    // Sessions: sess-0: Alice only = 1, sess-1: Alice only = 1, sess-2: both = 2 → avg = 4/3 ≈ 1
    const totalAttended = data.ministry.sessions.reduce((s, p) => s + p.totalAttended, 0);
    expect(totalAttended).toBe(4); // 1+1+2
  });

  // TC50 — sub-floor sessions are flagged as invalid (not a valid service)
  it('TC50: session below the attendance floor is marked as outlier', async () => {
    const { trendsSvc, settingsRepo } = await makeServices();
    // Floor of 2: sess-0 and sess-1 (1 attendee each) are below it; sess-2 (2) is valid.
    await settingsRepo.updateSettings({ serviceMinAttendance: 2 });
    const data = await trendsSvc.get(ADMIN);
    const byId = Object.fromEntries(data.ministry.sessions.map(s => [s.sessionId, s.isOutlier]));
    expect(byId['sess-0']).toBe(true);
    expect(byId['sess-1']).toBe(true);
    expect(byId['sess-2']).toBe(false);
  });

  // TC51 — grad scoping works
  it('TC51: grade-9 actor sees only grade-9 student attendance', async () => {
    const { trendsSvc, studentSvc } = await makeServices();
    // Add a grade-10 student who attends no sessions — they should not affect grade-9 view
    await studentSvc.create(ADMIN, { firstName: 'Carol', lastName: 'White', gender: 'female', grade: 10 });
    const data = await trendsSvc.get(actor('grade', { grade: 9 }));
    // Grade-9 has 2 students (Alice + Bob)
    // sess-2 both attend → totalAttended should be 2 for the final session
    const lastSession = data.ministry.sessions[data.ministry.sessions.length - 1];
    expect(lastSession?.totalAttended).toBe(2);
  });

  // TC52 — previous-term trend shown in at-risk entry
  it('TC52: at-risk entry includes previous-term fields', async () => {
    const { atRiskSvc, studentRepo, s2 } = await makeServices();
    // Set Bob as at-risk with prev-term data
    const bob = await studentRepo.findById(s2.id);
    if (bob) {
      await studentRepo.save({
        ...bob,
        svcAttended: 1, svcTotal: 8, // current: 12.5% — at risk
        prevSvcAttended: 6, prevSvcTotal: 8, // previous: 75% — was regular
      });
    }
    const list = await atRiskSvc.list(ADMIN);
    const bobEntry = list.find(e => e.fullName === 'Bob Jones');
    expect(bobEntry).toBeDefined();
    expect(bobEntry?.prevSvcAttended).toBe(6);
    expect(bobEntry?.prevSvcTotal).toBe(8);
    expect(bobEntry?.svcTrend).toBe('down');
  });

  // TC53 — trend direction no-data when no prev-term
  it('TC53: svcTrend is no-data when prev term is empty', async () => {
    const { atRiskSvc, studentRepo, s2 } = await makeServices();
    const bob = await studentRepo.findById(s2.id);
    if (bob) {
      await studentRepo.save({
        ...bob,
        svcAttended: 1, svcTotal: 8,
        prevSvcAttended: 0, prevSvcTotal: 0, // no previous data
      });
    }
    const list = await atRiskSvc.list(ADMIN);
    const bobEntry = list.find(e => e.fullName === 'Bob Jones');
    expect(bobEntry?.svcTrend).toBe('no-data');
  });

  // TC54 — groupSummary reflects increasing/decreasing students
  it('TC54: groupSummary classifies group attendance trends', async () => {
    const { trendsSvc, studentRepo, s1, s2 } = await makeServices();
    const alice = await studentRepo.findById(s1.id);
    const bob = await studentRepo.findById(s2.id);
    if (alice) await studentRepo.save({ ...alice, grpAttended: 5, grpTotal: 6, prevGrpAttended: 3, prevGrpTotal: 6 }); // improving
    if (bob) await studentRepo.save({ ...bob, grpAttended: 2, grpTotal: 6, prevGrpAttended: 5, prevGrpTotal: 6 }); // declining
    const data = await trendsSvc.get(ADMIN);
    expect(data.groupSummary.studentsIncreasing).toBe(1);
    expect(data.groupSummary.studentsDecreasing).toBe(1);
  });
});
