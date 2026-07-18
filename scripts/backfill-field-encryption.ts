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
