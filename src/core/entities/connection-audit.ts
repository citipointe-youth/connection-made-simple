import type { ID, ISODateString } from '../types/common';
import type { LabeledTerm } from '../../services/year-terms';
import type { AuditLgStat } from '../../services/attendance-build';

// One CRM-upload overlay row (Student Team / Connect / Decision / People Flow).
// Stored verbatim and rendered client-side. Team/Connect/Decision use {name,date};
// People Flow uses {person,step,status,entered,days,admin} — hence the open shape.
export interface AuditUploadRow { name?: string; date?: string | null; [key: string]: unknown; }

export interface AuditStudentRow {
  id: string;
  firstName: string;
  lastName: string;
  gender: 'male' | 'female' | 'other';
  grade: number | null;
  quad: string | null;
}

// Per-term frozen figures for one term.
export interface AuditTermSnapshot {
  key: string;            // matches LabeledTerm.key
  svcTotal: number;       // valid services in the term
  inProgress: boolean;    // true for the latest term of a mid-term (YTD) upload
  // studentId -> attendance in this term
  byStudent: Record<string, { svcAttended: number; grpAttended: number; grpTotal: number }>;
}

export interface AuditSnapshot {
  generatedAt: ISODateString;
  dataStartDate: string | null; // earliest valid service date in the upload
  dataEndDate: string | null;   // latest valid service date in the upload
  terms: LabeledTerm[];
  students: AuditStudentRow[];
  perTerm: Record<string, AuditTermSnapshot>;
  // Per-named-lifegroup stats keyed by term — powers the Lifegroup Health tab.
  lgStatsByTerm: Record<string, AuditLgStat[]>;
  uploads: {
    team: AuditUploadRow[];
    connect: AuditUploadRow[];
    decision: AuditUploadRow[];
    flows: AuditUploadRow[];
  };
}

export interface ConnectionAudit {
  id: ID;          // we use the year string as the id, e.g. "2026" — one row per year
  year: number;
  label: string;   // e.g. "2026 (year-to-date)"
  uploadedBy: string;
  uploadedAt: ISODateString;
  snapshot: AuditSnapshot;
}
