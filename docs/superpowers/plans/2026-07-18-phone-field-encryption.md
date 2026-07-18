# Student/Parent Phone Field Encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt `students.mobile` and `students.parent_phone` at rest (AES-256-GCM, application layer) so raw Supabase DB access reveals only ciphertext, while every service/export continues to see plaintext.

**Architecture:** Port the already-deployed field-encryption codec from the sibling Youth Camp Platform repo (`src/utils/field-crypto.ts`) verbatim, then wire it into the one seam where raw columns become a `Student` entity: `src/repositories/supabase/supabase.students.ts` (`toStudent` on read, `save`/`saveMany` on write). No schema migration — both fields are already plain `text` columns, encrypted in place.

**Tech Stack:** TypeScript (strict), `node:crypto` (AES-256-GCM), `postgres.js` (Supabase driver), Vitest.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-18-phone-field-encryption-design.md` — every task below implements a piece of it.
- Extensionless ESM imports (`moduleResolution: "Bundler"`) — no `.js` suffixes.
- Strict TypeScript: `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.
- Only `src/repositories/supabase/supabase.students.ts` changes behavior — every service, the SPA, and the `memory`/`json` repos must be unaffected (they never see ciphertext).
- `npm run typecheck` and `npm run test` must stay green after every task.
- **This repo deploys straight to production on push to `master` — there is no PR/review gate.** Do not push until Tasks 1–5 (all code + tests) are complete and green.
- The encryption key for this app must be **newly generated**, distinct from the Youth Camp Platform's key.

---

## File Structure

- **Create** `src/utils/field-crypto.ts` — pure AES-256-GCM codec, no DB/framework dependency. Ported verbatim from the camp platform.
- **Create** `src/utils/field-crypto.test.ts` — codec unit tests.
- **Modify** `src/repositories/supabase/supabase.students.ts` — add the AAD helper, `encryptPhoneFields()`, wire `maybeEncrypt`/`maybeDecrypt` into `toStudent`/`save`/`saveMany`.
- **Create** `src/repositories/supabase/supabase.students.mapper.test.ts` — round-trip test proving ciphertext-on-the-wire, plaintext-on-the-entity, null preservation, legacy-plaintext tolerance.
- **Create** `scripts/backfill-field-encryption.ts` — one-off, idempotent, resumable prod backfill.
- **Modify** `CLAUDE.md` — changelog entry.

---

### Task 1: Port the field-crypto codec

**Files:**
- Create: `src/utils/field-crypto.ts`
- Test: `src/utils/field-crypto.test.ts`

**Interfaces:**
- Produces: `encryptField(plaintext: string, aad: string): string`, `decryptField(envelope: string, aad: string): string`, `isEncrypted(value: unknown): value is string`, `maybeEncrypt(value: string | null | undefined, aad: string): string | null`, `maybeDecrypt(value: string | null | undefined, aad: string): string | null`. Task 2 consumes all five.

- [ ] **Step 1: Write the failing test**

Create `src/utils/field-crypto.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import {
  isEncrypted, encryptField, decryptField, maybeEncrypt, maybeDecrypt,
} from './field-crypto';

const KEY = Buffer.alloc(32, 1).toString('base64');
const KEY2 = Buffer.alloc(32, 2).toString('base64');

beforeAll(() => {
  process.env['FIELD_ENCRYPTION_KEY'] = KEY;
  process.env['FIELD_ENCRYPTION_KEY_ID'] = 'k1';
});

describe('field-crypto', () => {
  it('round-trips a value under matching AAD', () => {
    const ct = encryptField('0411928301', 'students:mobile:s_1');
    expect(isEncrypted(ct)).toBe(true);
    expect(ct.startsWith('v1.k1.')).toBe(true);
    expect(decryptField(ct, 'students:mobile:s_1')).toBe('0411928301');
  });

  it('produces a fresh IV each call (ciphertexts differ)', () => {
    const a = encryptField('x', 'students:mobile:s_1');
    const b = encryptField('x', 'students:mobile:s_1');
    expect(a).not.toBe(b);
  });

  it('rejects decryption under the wrong AAD (bound to row+column)', () => {
    const ct = encryptField('secret', 'students:mobile:s_1');
    expect(() => decryptField(ct, 'students:mobile:s_2')).toThrow();
  });

  it('rejects a tampered ciphertext (auth tag fails)', () => {
    const ct = encryptField('secret', 'students:parent_phone:s_1');
    const parts = ct.split('.');
    const flipped = parts[4]!.slice(0, -2) + (parts[4]!.endsWith('A') ? 'B' : 'A');
    const bad = [parts[0], parts[1], parts[2], parts[3], flipped].join('.');
    expect(() => decryptField(bad, 'students:parent_phone:s_1')).toThrow();
  });

  it('maybeEncrypt passes null/empty through as null', () => {
    expect(maybeEncrypt(null, 'a')).toBeNull();
    expect(maybeEncrypt(undefined, 'a')).toBeNull();
    expect(maybeEncrypt('', 'a')).toBeNull();
  });

  it('maybeDecrypt passes null and legacy plaintext through unchanged', () => {
    expect(maybeDecrypt(null, 'a')).toBeNull();
    expect(maybeDecrypt('0400111222', 'a')).toBe('0400111222');
  });

  it('decrypts ciphertext written under a now-PREV key', () => {
    const ct = encryptField('rotate me', 'students:parent_phone:s_9');
    process.env['FIELD_ENCRYPTION_KEY'] = KEY2;
    process.env['FIELD_ENCRYPTION_KEY_ID'] = 'k2';
    process.env['FIELD_ENCRYPTION_KEY_PREV'] = KEY;
    process.env['FIELD_ENCRYPTION_KEY_PREV_ID'] = 'k1';
    expect(decryptField(ct, 'students:parent_phone:s_9')).toBe('rotate me');
    process.env['FIELD_ENCRYPTION_KEY'] = KEY;
    process.env['FIELD_ENCRYPTION_KEY_ID'] = 'k1';
    delete process.env['FIELD_ENCRYPTION_KEY_PREV'];
    delete process.env['FIELD_ENCRYPTION_KEY_PREV_ID'];
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- field-crypto`
Expected: FAIL — `Cannot find module './field-crypto'`

- [ ] **Step 3: Write the implementation**

Create `src/utils/field-crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Self-describing envelope: "v1.<keyId>.<iv>.<tag>.<ct>" (each part base64url, unpadded).
// The "v1." prefix is the "is this already encrypted?" test — it keeps the backfill
// idempotent and lets reads tolerate a table that is any mix of plaintext + ciphertext.
const VERSION = 'v1';
const IV_LEN = 12; // 96-bit GCM nonce (standard, most efficient)
const KEY_LEN = 32; // AES-256

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeKey(b64: string, id: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`FIELD_ENCRYPTION key '${id}' must decode to ${KEY_LEN} bytes; got ${key.length}`);
  }
  return key;
}

function activeKeyId(): string {
  return process.env['FIELD_ENCRYPTION_KEY_ID'] || 'k1';
}

/** Build the id→key map fresh from the environment on each call (cheap; keeps tests trivial). */
function keyMap(): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  const active = process.env['FIELD_ENCRYPTION_KEY'];
  if (active) m.set(activeKeyId(), decodeKey(active, activeKeyId()));
  const prev = process.env['FIELD_ENCRYPTION_KEY_PREV'];
  if (prev) {
    const prevId = process.env['FIELD_ENCRYPTION_KEY_PREV_ID'] || 'k0';
    m.set(prevId, decodeKey(prev, prevId));
  }
  if (m.size === 0) {
    throw new Error('FIELD_ENCRYPTION_KEY is required to encrypt/decrypt sensitive fields');
  }
  return m;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VERSION + '.');
}

export function encryptField(plaintext: string, aad: string): string {
  const id = activeKeyId();
  const key = keyMap().get(id);
  if (!key) throw new Error(`field-crypto: no active key for id '${id}'`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, id, b64url(iv), b64url(tag), b64url(ct)].join('.');
}

export function decryptField(envelope: string, aad: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('field-crypto: malformed ciphertext envelope');
  }
  const id = parts[1]!;
  const key = keyMap().get(id);
  if (!key) throw new Error(`field-crypto: no key for id '${id}'`);
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(parts[2]!));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(fromB64url(parts[3]!));
  return Buffer.concat([decipher.update(fromB64url(parts[4]!)), decipher.final()]).toString('utf8');
}

/** Encrypt a nullable scalar. null/undefined/'' → null (never stored as ciphertext). */
export function maybeEncrypt(value: string | null | undefined, aad: string): string | null {
  if (value == null || value === '') return null;
  return encryptField(value, aad);
}

/** Decrypt a value that may be ciphertext, legacy plaintext, or null. */
export function maybeDecrypt(value: string | null | undefined, aad: string): string | null {
  if (value == null) return null;
  if (!isEncrypted(value)) return value; // legacy plaintext passthrough (rollout tolerance)
  return decryptField(value, aad);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- field-crypto`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/field-crypto.ts src/utils/field-crypto.test.ts
git commit -m "Add AES-256-GCM field-crypto codec (ported from camp platform)"
```

---

### Task 2: Wire encryption into the students Supabase mapper

**Files:**
- Modify: `src/repositories/supabase/supabase.students.ts`
- Test: `src/repositories/supabase/supabase.students.mapper.test.ts`

**Interfaces:**
- Consumes: `maybeEncrypt`, `maybeDecrypt` from `../../utils/field-crypto` (Task 1).
- Produces: `export function toStudent(row): Student` (now exported — was module-private), `export function encryptPhoneFields(s: Pick<Student,'id'|'mobile'|'parentPhone'>): { mobile: string | null; parent_phone: string | null }`. Task 3's test file imports both by name.

- [ ] **Step 1: Write the failing mapper test**

Create `src/repositories/supabase/supabase.students.mapper.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { toStudent, encryptPhoneFields } from './supabase.students';
import type { Student } from '../../core/entities/student';

beforeAll(() => {
  process.env['FIELD_ENCRYPTION_KEY'] = Buffer.alloc(32, 1).toString('base64');
  process.env['FIELD_ENCRYPTION_KEY_ID'] = 'k1';
});

function sampleStudent(): Student {
  return {
    id: 's_enc1',
    firstName: 'Ivy', lastName: 'Sample', gender: 'female',
    grade: 9, quad: 'g79',
    mobile: '0400000000', parentPhone: '0411111111',
    dateOfBirth: '2010-05-01',
    svcAttended: 3, svcTotal: 4, grpAttended: 2, grpTotal: 3, grpMetWeeks: 3,
    prevSvcAttended: 0, prevSvcTotal: 0, prevGrpAttended: 0, prevGrpTotal: 0,
    atRiskStatus: null, dataSource: 'csv',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function rowFor(s: Student, mobile: unknown, parentPhone: unknown): Record<string, unknown> {
  return {
    id: s.id, first_name: s.firstName, last_name: s.lastName, gender: s.gender,
    grade: s.grade, quad: s.quad,
    mobile, parent_phone: parentPhone,
    date_of_birth: s.dateOfBirth,
    svc_attended: s.svcAttended, svc_total: s.svcTotal,
    grp_attended: s.grpAttended, grp_total: s.grpTotal, grp_met_weeks: s.grpMetWeeks,
    prev_svc_attended: s.prevSvcAttended, prev_svc_total: s.prevSvcTotal,
    prev_grp_attended: s.prevGrpAttended, prev_grp_total: s.prevGrpTotal,
    at_risk_status: s.atRiskStatus, data_source: s.dataSource,
    created_at: new Date(s.createdAt), updated_at: new Date(s.updatedAt),
  };
}

describe('students mapper encryption', () => {
  it('encryptPhoneFields returns v1.-prefixed ciphertext for both fields', () => {
    const enc = encryptPhoneFields(sampleStudent());
    expect(String(enc.mobile).startsWith('v1.')).toBe(true);
    expect(String(enc.parent_phone).startsWith('v1.')).toBe(true);
  });

  it('round-trips through toStudent (ciphertext row -> plaintext entity)', () => {
    const s = sampleStudent();
    const enc = encryptPhoneFields(s);
    const row = rowFor(s, enc.mobile, enc.parent_phone);
    const back = toStudent(row);
    expect(back.mobile).toBe('0400000000');
    expect(back.parentPhone).toBe('0411111111');
  });

  it('preserves null (never stores ciphertext for a null phone)', () => {
    const s = { ...sampleStudent(), mobile: null, parentPhone: null };
    const enc = encryptPhoneFields(s);
    expect(enc.mobile).toBeNull();
    expect(enc.parent_phone).toBeNull();
    const row = rowFor(s, enc.mobile, enc.parent_phone);
    const back = toStudent(row);
    expect(back.mobile).toBeNull();
    expect(back.parentPhone).toBeNull();
  });

  it('reads legacy plaintext rows when not yet encrypted (rollout tolerance)', () => {
    const s = sampleStudent();
    const row = rowFor(s, '0400111222', '0400333444'); // plaintext, no v1. prefix
    const back = toStudent(row);
    expect(back.mobile).toBe('0400111222');
    expect(back.parentPhone).toBe('0400333444');
  });

  it('binds ciphertext to the student id (AAD) — same plaintext, different ciphertext', () => {
    const a = encryptPhoneFields({ id: 's_a', mobile: '0400000000', parentPhone: null });
    const b = encryptPhoneFields({ id: 's_b', mobile: '0400000000', parentPhone: null });
    expect(a.mobile).not.toBe(b.mobile);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- supabase.students.mapper`
Expected: FAIL — `toStudent`/`encryptPhoneFields` not exported from `./supabase.students`

- [ ] **Step 3: Modify the implementation**

In `src/repositories/supabase/supabase.students.ts`, replace lines 1–41 (imports through the end of `toStudent`) with:

```typescript
import type { SqlClient } from './client';
import { toIso } from './client';
import type { IStudentRepository } from '../interfaces/entity-repositories';
import type { Student } from '../../core/entities/student';
import type { Quad } from '../../core/types/enums';
import { chunk } from './bulk';
import { maybeEncrypt, maybeDecrypt } from '../../utils/field-crypto';

const aad = (col: string, id: string): string => `students:${col}:${id}`;

/**
 * Encrypts the two sensitive phone fields for a write. Shared by save() and
 * saveMany() so both bind ciphertext to the student id the same way.
 */
export function encryptPhoneFields(s: Pick<Student, 'id' | 'mobile' | 'parentPhone'>): {
  mobile: string | null;
  parent_phone: string | null;
} {
  return {
    mobile: maybeEncrypt(s.mobile, aad('mobile', s.id)),
    parent_phone: maybeEncrypt(s.parentPhone, aad('parent_phone', s.id)),
  };
}

export function toStudent(row: Record<string, unknown>): Student {
  const id = row['id'] as string;
  const dob = row['date_of_birth'];
  let dateOfBirth: string | null = null;
  if (dob instanceof Date) {
    dateOfBirth = dob.toISOString().split('T')[0]!;
  } else if (typeof dob === 'string') {
    dateOfBirth = dob;
  }

  return {
    id,
    firstName: row['first_name'] as string,
    lastName: row['last_name'] as string,
    gender: row['gender'] as Student['gender'],
    grade: (row['grade'] as number | null) ?? null,
    quad: (row['quad'] as Quad | null) ?? null,
    mobile: maybeDecrypt(row['mobile'] as string | null, aad('mobile', id)),
    parentPhone: maybeDecrypt(row['parent_phone'] as string | null, aad('parent_phone', id)),
    dateOfBirth,
    svcAttended: (row['svc_attended'] as number) ?? 0,
    svcTotal: (row['svc_total'] as number) ?? 0,
    grpAttended: (row['grp_attended'] as number) ?? 0,
    grpTotal: (row['grp_total'] as number) ?? 0,
    grpMetWeeks: (row['grp_met_weeks'] as number) ?? 0,
    prevSvcAttended: (row['prev_svc_attended'] as number) ?? 0,
    prevSvcTotal: (row['prev_svc_total'] as number) ?? 0,
    prevGrpAttended: (row['prev_grp_attended'] as number) ?? 0,
    prevGrpTotal: (row['prev_grp_total'] as number) ?? 0,
    atRiskStatus: (row['at_risk_status'] as Student['atRiskStatus']) ?? null,
    dataSource: (row['data_source'] as string | null) ?? null,
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  };
}
```

Then, in `save()`, insert one line before the `insert into students` template and change the two phone values in the `values (...)` list. The method becomes:

```typescript
  async save(student: Student): Promise<Student> {
    const enc = encryptPhoneFields(student);
    const rows = await this.sql`
      insert into students (
        id, first_name, last_name, gender, grade, quad, mobile, parent_phone, date_of_birth,
        svc_attended, svc_total, grp_attended, grp_total, grp_met_weeks,
        prev_svc_attended, prev_svc_total, prev_grp_attended, prev_grp_total,
        at_risk_status, data_source, created_at, updated_at
      )
      values (
        ${student.id},
        ${student.firstName},
        ${student.lastName},
        ${student.gender},
        ${student.grade ?? null},
        ${student.quad ?? null},
        ${enc.mobile},
        ${enc.parent_phone},
        ${student.dateOfBirth ?? null},
        ${student.svcAttended},
        ${student.svcTotal},
        ${student.grpAttended},
        ${student.grpTotal},
        ${student.grpMetWeeks},
        ${student.prevSvcAttended},
        ${student.prevSvcTotal},
        ${student.prevGrpAttended},
        ${student.prevGrpTotal},
        ${student.atRiskStatus ?? null},
        ${student.dataSource ?? null},
        ${student.createdAt},
        ${student.updatedAt}
      )
      on conflict (id) do update set
        first_name        = excluded.first_name,
        last_name         = excluded.last_name,
        gender            = excluded.gender,
        grade             = excluded.grade,
        quad              = excluded.quad,
        mobile            = excluded.mobile,
        parent_phone      = excluded.parent_phone,
        date_of_birth     = excluded.date_of_birth,
        svc_attended      = excluded.svc_attended,
        svc_total         = excluded.svc_total,
        grp_attended      = excluded.grp_attended,
        grp_total         = excluded.grp_total,
        grp_met_weeks     = excluded.grp_met_weeks,
        prev_svc_attended = excluded.prev_svc_attended,
        prev_svc_total    = excluded.prev_svc_total,
        prev_grp_attended = excluded.prev_grp_attended,
        prev_grp_total    = excluded.prev_grp_total,
        at_risk_status    = excluded.at_risk_status,
        data_source       = excluded.data_source,
        updated_at        = excluded.updated_at
      returning *
    `;
    return toStudent(rows[0]!);
  }
```

(The `on conflict … set` clause is unchanged — `excluded.mobile`/`excluded.parent_phone` already refer to whatever was just inserted, which is now ciphertext.)

In `saveMany()`, replace the two plaintext lines inside the `batch.map((s) => ({ ... }))` object literal:

```typescript
          mobile:            s.mobile ?? null,
          parent_phone:      s.parentPhone ?? null,
```

with:

```typescript
          ...encryptPhoneFields(s),
```

(placed in the same position in the object literal, between `quad:` and `date_of_birth:`). Leave every other field in `saveMany()` untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- supabase.students.mapper`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm run typecheck && npm run test`
Expected: both clean; no other test file references `toStudent` in a way that breaks from the export change (it was module-private before, exporting it is additive).

- [ ] **Step 6: Commit**

```bash
git add src/repositories/supabase/supabase.students.ts src/repositories/supabase/supabase.students.mapper.test.ts
git commit -m "Encrypt students.mobile/parent_phone at rest in the Supabase mapper"
```

---

### Task 3: Backfill script

**Files:**
- Create: `scripts/backfill-field-encryption.ts`

**Interfaces:**
- Consumes: `buildContainer()` from `../src/container` (existing — returns `Promise<{ repos, services }>`; `repos.students` implements `IStudentRepository` with `findAll()`/`saveMany()`, unchanged signatures from Task 2).

- [ ] **Step 1: Write the script**

Create `scripts/backfill-field-encryption.ts`:

```typescript
/**
 * One-off backfill: re-save every student through the encryption-aware Supabase
 * repo so mobile/parentPhone become ciphertext. Idempotent (already-encrypted
 * values decrypt then re-encrypt to the same plaintext), resumable (safe to
 * re-run after any interruption), order-independent (keyed by id).
 *
 * Run (bash):
 *   PERSISTENCE=supabase DATABASE_URL='<pooler url>' \
 *     FIELD_ENCRYPTION_KEY='<base64 32 bytes>' \
 *     npx tsx scripts/backfill-field-encryption.ts
 *
 * Run (PowerShell):
 *   $env:PERSISTENCE='supabase'; $env:DATABASE_URL='<pooler url>';
 *   $env:FIELD_ENCRYPTION_KEY='<base64 32 bytes>';
 *   npx tsx scripts/backfill-field-encryption.ts
 */
import { buildContainer } from '../src/container';

const BATCH = 200;

async function main(): Promise<void> {
  if (process.env['PERSISTENCE'] !== 'supabase') {
    throw new Error('Refusing to run: set PERSISTENCE=supabase (this backfill targets the live DB).');
  }
  if (!process.env['FIELD_ENCRYPTION_KEY']) {
    throw new Error('FIELD_ENCRYPTION_KEY is required.');
  }
  const { repos } = await buildContainer();

  const students = await repos.students.findAll();
  console.log(`students: ${students.length} rows`);
  for (let i = 0; i < students.length; i += BATCH) {
    const batch = students.slice(i, i + BATCH);
    await repos.students.saveMany(batch);
    console.log(`  students ${Math.min(i + BATCH, students.length)}/${students.length}`);
  }

  console.log('Backfill complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck it**

Run: `npm run typecheck`
Expected: clean (the script is excluded from `vitest` runs but must still type-check under the repo's `tsconfig.json`; if `tsconfig.json` excludes `scripts/`, confirm it compiles standalone with `npx tsc --noEmit scripts/backfill-field-encryption.ts` instead).

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-field-encryption.ts
git commit -m "Add one-off backfill script for phone-field encryption"
```

---

### Task 4: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append a changelog entry**

Add this section near the top of `CLAUDE.md`'s dated-changelog area (mirroring the existing entry style), after confirming the actual deploy happened (fold in the real commit outcome once Task 6+ complete):

```markdown
## Phone field encryption at rest (students.mobile / students.parent_phone) — implemented 2026-07-18

Both fields are encrypted at rest with AES-256-GCM (`src/utils/field-crypto.ts`, ported from
the Youth Camp Platform's field-encryption feature) so raw DB access (incl. Supabase staff/SQL
editor) reveals only ciphertext, while every service/export still sees plaintext. Design:
`docs/superpowers/specs/2026-07-18-phone-field-encryption-design.md`; plan:
`docs/superpowers/plans/2026-07-18-phone-field-encryption.md`.

- **Scope + seam:** the codec is called ONLY inside `supabase.students.ts` (`toStudent`/
  `save`/`saveMany`, via `encryptPhoneFields()`). Services, `memory`/`json` persistence, and the
  SPA are all unaware encryption exists. No schema migration — both fields are plain `text`
  columns, encrypted in place (unlike the camp platform, which needed new `*_enc` columns for
  its array/jsonb fields).
- **Envelope:** `v1.<keyId>.<iv>.<tag>.<ct>` — the `v1.` prefix lets reads tolerate a table
  that's any mix of ciphertext + not-yet-migrated plaintext, and makes the backfill idempotent.
  Bound via AAD to `"students:<column>:<id>"`.
- **Key:** `FIELD_ENCRYPTION_KEY` (base64, 32 bytes) in Vercel prod env — a key distinct from the
  camp platform's. Losing it = losing the two phone fields permanently (the security property,
  not a bug).
- **Rollout:** deploy the encryption-aware code → run `scripts/backfill-field-encryption.ts`
  against prod (idempotent/resumable) → verify no non-null value lacks the `v1.` prefix →
  `VACUUM FULL students;` to physically purge leftover plaintext row versions from disk.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document phone-field encryption in CLAUDE.md"
```

---

### Task 5: Final pre-deploy gate

**Files:** none (verification only)

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm run test`
Expected: both clean. This is the last check before anything touches production — do not proceed to Task 6 if either fails.

---

## Deployment tasks (production — execute directly, not via a fresh subagent)

These tasks touch the live Vercel project and production Supabase database. Because a push to
`master` deploys immediately with no review gate, and because they require the real production
`DATABASE_URL`/key, they should be run by the orchestrating session directly (with the user's
"full rollout" approval already on record), not handed to an isolated subagent.

### Task 6: Generate and set the production key

- [ ] **Step 1: Generate a new 32-byte key**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- [ ] **Step 2: Set it in Vercel production env (non-interactive)**

From the repo root (already linked via `.vercel/project.json`):

```bash
printf '%s' "<the generated key>" | vercel env add FIELD_ENCRYPTION_KEY production
```

Confirm: `vercel env ls` shows `FIELD_ENCRYPTION_KEY` present for `Production`.

### Task 7: Push to master (deploy)

- [ ] **Step 1: Push**

```bash
git push origin master
```

- [ ] **Step 2: Confirm the deploy landed**

Check the latest production deployment is `READY` and built from the pushed commit (Vercel
dashboard, `vercel ls`, or the `mcp__plugin_vercel_vercel__get_deployment` tool on the production
alias) before proceeding — the backfill script in Task 8 depends on the new code already being
live (old code would just re-write plaintext).

### Task 8: Run the backfill against production

- [ ] **Step 1: Pull production env vars locally**

```bash
vercel env pull .env.production.local --environment=production
```

Open the pulled file and confirm both `DATABASE_URL` and `FIELD_ENCRYPTION_KEY` are present with
real values (not blank — a var marked "Sensitive" in the Vercel dashboard can pull back empty;
if either is empty, fetch the value from the Vercel dashboard directly instead).

- [ ] **Step 2: Run the backfill**

```bash
set -a; source .env.production.local; set +a
PERSISTENCE=supabase npx tsx scripts/backfill-field-encryption.ts
```

Expected output: `students: N rows` followed by progress lines, ending `Backfill complete.`

- [ ] **Step 3: Delete the local env file (contains prod secrets)**

```bash
rm .env.production.local
```

### Task 9: Verify + purge plaintext

- [ ] **Step 1: Verify every non-null phone value is encrypted**

Run against the production Supabase project (ref `ltcblcudlzlzfcyzlhpc`) via the Supabase MCP
`execute_sql` tool or the SQL editor:

```sql
select count(*) from students where mobile is not null and mobile not like 'v1.%';
select count(*) from students where parent_phone is not null and parent_phone not like 'v1.%';
```

Expected: both return `0`.

- [ ] **Step 2: Spot-check a decrypt round-trip via the app**

Open the live app, search for a student known to have a mobile/parent number on file, confirm it
displays correctly (proves `toStudent`'s decrypt path works against real prod ciphertext, not
just the unit tests).

- [ ] **Step 3: Purge leftover plaintext from disk**

```sql
VACUUM FULL students;
```

This takes a brief exclusive lock — fine for this app's traffic pattern, but avoid running it
mid-CSV-import. After this, the "unreadable to Supabase staff" guarantee is real, not just
logically true.

---

## Self-Review

**Spec coverage:** field scope (✓ Task 2), crypto design/envelope (✓ Task 1), key management
(✓ Task 6), mapper integration (✓ Task 2), rollout steps 1–4 (✓ Tasks 7–9), testing (✓ Tasks 1–2),
docs (✓ Task 4). No spec section without a task.

**Placeholder scan:** none found — every step has complete, runnable code or an exact command.

**Type consistency:** `encryptPhoneFields` returns `{ mobile: string | null; parent_phone: string
| null }` in Task 2 and is consumed with that exact shape in both `save()` (`enc.mobile`/
`enc.parent_phone`) and `saveMany()` (spread) and in the Task 2 test file (`enc.mobile`/
`enc.parent_phone`). `toStudent` signature (`(row: Record<string, unknown>) => Student`) is
unchanged from the original, just exported — no call site elsewhere in the codebase breaks.
