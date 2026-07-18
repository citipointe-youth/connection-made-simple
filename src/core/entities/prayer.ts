import type { ID, ISODateString } from '../types/common';
import type { UserRole } from '../types/enums';

export type PrayerStatus = 'open' | 'answered' | 'archived';

export interface PrayerRequest {
  id: ID;
  // null = not tied to a specific student (e.g. someone outside the app, or a
  // whole-group request) — visible to every actor with prayer:read, since there's
  // no student scope to resolve it through.
  studentId: ID | null;
  text: string;
  status: PrayerStatus;
  answerNote: string | null;
  createdByLabel: string;
  createdByRole: UserRole;
  // The creator's grade+gender domain at creation time (access-control.ts's
  // generalPrayerCreatorScope) — only meaningful when studentId is null. Both
  // null means "no boundary" (admin/director, or a leader — see that function).
  // Ignored for a student-linked prayer, which scopes through the student instead.
  createdByGrades: number[] | null;
  createdByGender: 'male' | 'female' | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  answeredAt: ISODateString | null;
}

export interface PrayerWithStudent extends PrayerRequest {
  student: { id: ID; firstName: string; lastName: string; grade: number | null; gender: string } | null;
}
