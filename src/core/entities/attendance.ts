import type { ID, ISODateString } from '../types/common';

// A single service session (weekly gathering)
export interface ServiceSession {
  id: ID;
  // null once its originating import-history row has been cleared (the FK is
  // ON DELETE SET NULL) — the session data itself is retained. Set at import time.
  importId: string | null;
  sessionDate: string;
  sessionName: string;
  isRegular: boolean;
  isValid: boolean;
  totalAttendance: number;
  sortOrder: number;
  createdAt: ISODateString;
}

// A single service attendance record
export interface ServiceAttendance {
  studentId: string;
  sessionId: string;
  attended: boolean;
}

// A lifegroup / small group definition
export interface Lifegroup {
  id: ID;
  fullName: string;
  shortName: string;
  grade: number | null;
  gender: string | null;
  createdAt: ISODateString;
}

// A weekly lifegroup meeting
export interface LifegroupWeek {
  id: ID;
  // null once its originating import-history row has been cleared (the FK is
  // ON DELETE SET NULL) — the week data itself is retained. Set at import time.
  importId: string | null;
  weekNum: number;
  weekKey: string;
  weekStart: string;
  weekEnd: string | null;
}

// A lifegroup attendance record
export interface LifegroupAttendance {
  studentId: string;
  weekId: string;
  lifegroupId: string;
  groupMet: boolean;
  attended: boolean;
}

// Import record
export interface ImportRecord {
  id: ID;
  type: 'service' | 'lifegroup';
  filename: string;
  fileHash: string;
  rowCount: number;
  sessionsAdded: number;
  studentsAdded: number;
  studentsUpdated: number;
  status: 'ok' | 'error';
  errorMessage: string | null;
  importedAt: ISODateString;
  importedBy: string;
}
