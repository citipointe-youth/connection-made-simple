import { describe, it, expect, beforeEach } from 'vitest';
import { canAccessStudent, type StructureScope } from '../services/access-control';
import { makeStudentService } from '../services/student.service';
import { makeOverviewService, invalidateOverviewCache } from '../services/overview.service';
import { makeAtRiskService } from '../services/atrisk.service';
import {
  InMemoryStudentRepository, InMemoryLeaderRepository,
  InMemoryConnectionRepository, InMemorySettingsRepository,
} from '../repositories/in-memory';
import { MINISTRY_CONFIG_DEFAULTS, mergeMinistryConfig } from '../core/ministry-config';
import type { Actor } from '../core/entities/user';
import type { Student } from '../core/entities/student';
import { computeQuad } from '../core/types/enums';

// Design §9 risk 2 — the visibility test matrix. cohortModel used to make
// 'none' bypass ALL grade/gender scoping ("show everyone"); as of the bug 8
// follow-up (2026-07-11) it no longer does — a Simple ministry's own grade
// accounts are scoped to their assigned bracket exactly like a Complex one's,
// so 'none' and 'grades-quads' now scope identically for a per-actor read.
// cohortModel's only remaining effect is on REPORTING breakdowns (overview's
// byQuad/byGrade, last describe block below), which stay hidden under 'none'
// since a Simple ministry has no quad rollups and coarser grade brackets to
// break down by. genderPolicy independently relaxes gender scoping regardless
// of cohortModel. Asserted as student-visibility counts across every scoped
// read service.

const COHORTS = ['grades-quads', 'none'] as const;
const POLICIES = ['strict', 'soft', 'off'] as const;

function scope(cohortModel: string, genderPolicy: string): StructureScope {
  return { cohortModel: cohortModel as any, genderPolicy: genderPolicy as any };
}

// A multi-grade grade login: grades 7,8,9, scoped to girls.
const juniorGirls: Actor = { id: 'jg', role: 'grade', displayName: 'JG', grade: null, grades: [7, 8, 9], quad: null, gender: 'female' };

describe('canAccessStudent — cohortModel × genderPolicy matrix (multi-grade grade login)', () => {
  // Students spanning grades 6..13 (outside + inside the default 7-12) × 2 genders.
  const sample: { grade: number; gender: string }[] = [];
  for (let g = 6; g <= 13; g++) for (const gender of ['female', 'male']) sample.push({ grade: g, gender });

  for (const cohortModel of COHORTS) {
    for (const genderPolicy of POLICIES) {
      it(`${cohortModel} / ${genderPolicy}`, () => {
        const sc = scope(cohortModel, genderPolicy);
        const visible = sample.filter((s) => canAccessStudent(juniorGirls, s.grade, s.gender, sc));
        // Same result under 'none' as under 'grades-quads' — cohortModel no
        // longer affects per-actor scoping (only genderPolicy does).
        if (genderPolicy === 'strict') {
          // grades 7,8,9 AND female only.
          expect(visible.every((s) => [7, 8, 9].includes(s.grade) && s.gender === 'female')).toBe(true);
          expect(visible.length).toBe(3);
        } else {
          // soft/off: grades 7,8,9, BOTH genders.
          expect(visible.every((s) => [7, 8, 9].includes(s.grade))).toBe(true);
          expect(visible.length).toBe(6);
        }
      });
    }
  }
});

// ── Integration: prove each scoped read service THREADS the structure config. ──

let nextId = 0;
// Attended LAST term but nothing this term → computeStatus() = 'stopped' (at-risk)
// AND counted as "connectable" (attended in the previous term) by overview.
function mkStudent(grade: number | null, gender: 'male' | 'female'): Student {
  const now = new Date().toISOString();
  return {
    id: 's' + nextId++, firstName: 'F' + nextId, lastName: 'L' + nextId, gender, grade,
    quad: computeQuad(grade, gender), mobile: null, parentPhone: null, dateOfBirth: null,
    svcAttended: 0, svcTotal: 1, grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
    prevSvcAttended: 1, prevSvcTotal: 1, prevGrpAttended: 0, prevGrpTotal: 0,
    atRiskStatus: 'stopped', dataSource: 'test', createdAt: now, updatedAt: now,
  };
}

async function harness(cohortModel: string, genderPolicy: string) {
  invalidateOverviewCache();
  const students = new InMemoryStudentRepository();
  const leaders = new InMemoryLeaderRepository();
  const conns = new InMemoryConnectionRepository();
  const settings = new InMemorySettingsRepository();
  await Promise.all([students.init(), leaders.init(), conns.init(), settings.init()]);
  await settings.updateSettings({
    ministryConfig: mergeMinistryConfig(MINISTRY_CONFIG_DEFAULTS, { structure: { cohortModel, genderPolicy } }),
  });
  // grades 7..9 (in range) × both genders, one student each.
  for (let g = 7; g <= 9; g++) for (const gender of ['female', 'male'] as const) await students.save(mkStudent(g, gender));
  // plus two grade-10 (out of the junior login's set) students.
  await students.save(mkStudent(10, 'female'));
  await students.save(mkStudent(10, 'male'));
  return {
    students, settings,
    studentSvc: makeStudentService(students, settings),
    overviewSvc: makeOverviewService(students, leaders, conns, settings),
    atriskSvc: makeAtRiskService(students, settings),
  };
}

describe('student.service.list threads structure (multi-grade junior-girls login)', () => {
  const cases: [string, string, number][] = [
    ['grades-quads', 'strict', 3], // grades 7,8,9 female
    ['grades-quads', 'soft', 6],   // grades 7,8,9 both genders
    ['grades-quads', 'off', 6],
    ['none', 'strict', 3],         // same as grades-quads — cohortModel no longer bypasses scoping
    ['none', 'soft', 6],
    ['none', 'off', 6],
  ];
  for (const [cohortModel, genderPolicy, expected] of cases) {
    it(`${cohortModel}/${genderPolicy} → ${expected} students`, async () => {
      const { studentSvc } = await harness(cohortModel, genderPolicy);
      const list = await studentSvc.list(juniorGirls);
      expect(list.length).toBe(expected);
    });
  }
});

describe('atrisk.service.list threads structure', () => {
  it('junior-girls sees only grades 7-9 female under strict, whichever cohortModel', async () => {
    const strict = await harness('grades-quads', 'strict');
    expect((await strict.atriskSvc.list(juniorGirls)).length).toBe(3);
    // 'none' scopes identically to 'grades-quads' now (bug 8 follow-up) — no
    // longer bypasses grade/gender scoping.
    const none = await harness('none', 'strict');
    expect((await none.atriskSvc.list(juniorGirls)).length).toBe(3);
  });
});

describe('overview.service hides byQuad/byGrade under cohortModel none', () => {
  beforeEach(() => invalidateOverviewCache());
  const admin: Actor = { id: 'adm', role: 'admin', displayName: 'A', grade: null, quad: null };
  it('grades-quads: byQuad + byGrade populated', async () => {
    const { overviewSvc } = await harness('grades-quads', 'strict');
    const stats = await overviewSvc.getStats(admin);
    expect(stats.byQuad.length).toBe(4);
    expect(stats.byGrade.length).toBe(6); // gradeRange 7..12
    expect(stats.ministryTotal).toBe(8);
  });
  it('none: byQuad + byGrade empty, ministry total unchanged (nothing hidden)', async () => {
    const { overviewSvc } = await harness('none', 'off');
    const stats = await overviewSvc.getStats(admin);
    expect(stats.byQuad).toEqual([]);
    expect(stats.byGrade).toEqual([]);
    expect(stats.ministryTotal).toBe(8); // every student still counted
  });
});
