import { z } from 'zod';
import { generateId } from '../utils/id';
import { computeQuad } from '../core/types/enums';

// Pure CSV → attendance-model builders for the Connection Audit. The audit is a
// self-contained snapshot: it parses its OWN year-to-date service + group CSVs
// (it never touches the live tables). Output is keyed by a normalised *name*
// rather than a student id, so the audit service can assign ONE id per unique
// person across both the service and group streams. The live importer keeps its
// own parsing — its student-merge semantics differ from this fresh-roster path.

// ── shared helpers ──
const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// ISO (YYYY-MM-DD) or Excel short-date (D-MMM / D-MMM-YY) → ISO, else null.
export function normaliseServiceDate(key: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const m = key.match(/^(\d{1,2})-([A-Za-z]{3})(?:-(\d{2,4}))?$/);
  if (!m) return null;
  const day = m[1]!.padStart(2, '0');
  const mon = MONTH_MAP[m[2]!.toLowerCase()];
  if (!mon) return null;
  let year: number;
  if (m[3]) {
    year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
  } else {
    const now = new Date();
    year = now.getFullYear();
    const parsed = new Date(`${year}-${mon}-${day}`);
    if (parsed.getTime() - now.getTime() > 60 * 24 * 3600 * 1000) year--;
  }
  return `${year}-${mon}-${day}`;
}

// Monday on/before a date — the week bucket (matches import.service weekStartOf).
function weekStartOf(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDate;
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function nameKeyOf(first: string, last: string): string {
  return `${first.toLowerCase()} ${last.toLowerCase()}`;
}

function isAttended(val: unknown): boolean {
  return val === true || val === 'true' || val === '1' ||
    String(val).toLowerCase() === 'yes' || String(val) === 'Y';
}

const ServiceRowSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  gender: z.string(),
  grade: z.coerce.number().int().min(7).max(12).nullable().optional(),
});

// ── service builder ──
export interface BuiltSession { id: string; sessionDate: string; isValid: boolean; }
export interface ServiceRosterEntry {
  nameKey: string;
  firstName: string;
  lastName: string;
  gender: 'male' | 'female' | 'other';
  grade: number | null;
  quad: string | null;
}
export interface ServiceParsed {
  sessions: BuiltSession[];
  roster: ServiceRosterEntry[];
  attendance: { nameKey: string; sessionId: string; attended: boolean }[];
}

export function buildServiceModel(rows: unknown[], serviceMinAttendance: number): ServiceParsed {
  if (!Array.isArray(rows) || rows.length === 0) return { sessions: [], roster: [], attendance: [] };

  const sampleRow = rows[0] as Record<string, unknown>;
  const dateCols = Object.keys(sampleRow)
    .map((origKey) => ({ origKey, iso: normaliseServiceDate(origKey) }))
    .filter((c): c is { origKey: string; iso: string } => c.iso !== null);

  // One session per distinct ISO date.
  const sessionByDate = new Map<string, BuiltSession>();
  for (const c of dateCols) {
    if (!sessionByDate.has(c.iso)) sessionByDate.set(c.iso, { id: generateId(), sessionDate: c.iso, isValid: true });
  }

  const rosterByName = new Map<string, ServiceRosterEntry>();
  const attMap = new Map<string, { nameKey: string; sessionId: string; attended: boolean }>();
  const attendedCount = new Map<string, number>();

  for (const rawRow of rows) {
    const parsed = ServiceRowSchema.safeParse(rawRow);
    if (!parsed.success) continue;
    const row = parsed.data;
    const g = row.gender.toLowerCase();
    const gender: 'male' | 'female' | 'other' =
      g === 'f' || g === 'female' ? 'female' : g === 'm' || g === 'male' ? 'male' : 'other';
    const grade = row.grade ?? null;
    const nameKey = nameKeyOf(row.first_name, row.last_name);
    rosterByName.set(nameKey, {
      nameKey, firstName: row.first_name, lastName: row.last_name, gender, grade,
      quad: computeQuad(grade, gender),
    });

    for (const c of dateCols) {
      const session = sessionByDate.get(c.iso)!;
      const attended = isAttended((rawRow as Record<string, unknown>)[c.origKey]);
      attMap.set(`${nameKey}:${session.id}`, { nameKey, sessionId: session.id, attended });
      if (attended) attendedCount.set(session.id, (attendedCount.get(session.id) ?? 0) + 1);
    }
  }

  for (const s of sessionByDate.values()) {
    s.isValid = (attendedCount.get(s.id) ?? 0) >= serviceMinAttendance;
  }

  return { sessions: [...sessionByDate.values()], roster: [...rosterByName.values()], attendance: [...attMap.values()] };
}

// ── group builder ──
export interface BuiltWeek { id: string; weekStart: string; }
export interface GroupRosterEntry { nameKey: string; firstName: string; lastName: string; }
export interface GroupParsed {
  weeks: BuiltWeek[];
  roster: GroupRosterEntry[];
  attendance: { nameKey: string; weekId: string; attended: boolean }[];
}

export interface GroupInput {
  name: string;
  meetings: string[];
  members: { first_name: string; last_name: string; attendance: (boolean | null)[] }[];
}

const LEADER_RE = /\(\s*(?:assistant\s+)?leaders?\s*\)/i;
const LEADER_RE_G = /\(\s*(?:assistant\s+)?leaders?\s*\)/ig;

export function buildGroupModel(groups: GroupInput[]): GroupParsed {
  if (!Array.isArray(groups) || groups.length === 0) return { weeks: [], roster: [], attendance: [] };

  const weekByKey = new Map<string, BuiltWeek>(); // `${groupId}|${weekStart}` -> week
  const ensureWeek = (groupId: string, weekStart: string): string => {
    const k = `${groupId}|${weekStart}`;
    let e = weekByKey.get(k);
    if (!e) { e = { id: generateId(), weekStart }; weekByKey.set(k, e); }
    return e.id;
  };

  const rosterByName = new Map<string, GroupRosterEntry>();
  const attendance: { nameKey: string; weekId: string; attended: boolean }[] = [];

  for (const group of groups) {
    const groupId = generateId();
    const weekOfIdx = group.meetings.map((d) => weekStartOf(d));

    const youth = group.members.filter((m) => !LEADER_RE.test(`${m.first_name} ${m.last_name}`));

    // Weeks the group ran = weeks where ≥1 youth has a non-null mark.
    const weeksRan = new Set<string>();
    for (const m of youth) {
      for (let i = 0; i < m.attendance.length; i++) {
        const a = m.attendance[i];
        if (a === null || a === undefined) continue;
        const w = weekOfIdx[i];
        if (w) weeksRan.add(w);
      }
    }
    const weeksRanList = [...weeksRan];

    for (const m of youth) {
      const attendedWeeks = new Set<string>();
      for (let i = 0; i < m.attendance.length; i++) {
        if (m.attendance[i] === true) { const w = weekOfIdx[i]; if (w) attendedWeeks.add(w); }
      }
      if (attendedWeeks.size === 0) continue; // 0 weeks → not part of the group

      const cleanFirst = m.first_name.replace(LEADER_RE_G, ' ').replace(/\s+/g, ' ').trim();
      const cleanLast = m.last_name.replace(LEADER_RE_G, ' ').replace(/\s+/g, ' ').trim();
      const nameKey = nameKeyOf(cleanFirst, cleanLast);
      rosterByName.set(nameKey, { nameKey, firstName: cleanFirst, lastName: cleanLast });

      for (const w of weeksRanList) {
        attendance.push({ nameKey, weekId: ensureWeek(groupId, w), attended: attendedWeeks.has(w) });
      }
    }
  }

  // One row per (name, weekId).
  const seen = new Set<string>();
  const deduped = attendance.filter((r) => {
    const k = `${r.nameKey}:${r.weekId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { weeks: [...weekByKey.values()], roster: [...rosterByName.values()], attendance: deduped };
}
