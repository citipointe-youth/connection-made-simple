import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { verifyPassword, hashPassword, needsRehash } from '../utils/crypto';
import type { IUserRepository } from '../repositories/interfaces/entity-repositories';
import type { Actor, User, SafeUser } from '../core/entities/user';
import type { Grade, Quad } from '../core/types/enums';
import { UnauthorizedError } from '../core/errors/app-error';
import { LoginInputSchema } from '../core/validation/auth.schema';
import { quadGenderOf } from './access-control';

// Derive a grade/quad login's gender scope. Quad logins come from their quad;
// grade logins from the email convention (grade7g -> female, grade7b -> male,
// or a "girls"/"boys" word). Anything else (incl. an ungendered grade account
// or director/admin) returns null = no gender restriction.
export function deriveActorGender(user: User): 'male' | 'female' | null {
  if (user.role === 'quad') return quadGenderOf(user.quad);
  if (user.role === 'grade') {
    const local = (user.email || '').split('@')[0]?.toLowerCase() ?? '';
    if (!local.startsWith('grade')) return null;
    if (/^grade\s*\d+\s*g$/.test(local) || local.includes('girl')) return 'female';
    if (/^grade\s*\d+\s*b$/.test(local) || local.includes('boy') || local.includes('guy')) return 'male';
  }
  return null;
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const INSECURE_FALLBACK = 'cms-dev-secret-change-in-production';
const SESSION_SECRET = process.env['SESSION_SECRET'] ?? INSECURE_FALLBACK;

if (process.env['NODE_ENV'] === 'production' && SESSION_SECRET === INSECURE_FALLBACK) {
  // eslint-disable-next-line no-console
  console.error(
    '[SECURITY] SESSION_SECRET env var is not set. ' +
    'Session tokens can be forged. Set SESSION_SECRET in your deployment environment immediately.'
  );
}

// The signed token carries the full actor so authenticated requests don't need
// a DB lookup to resolve the caller — the HMAC guarantees it wasn't tampered
// with. (Trade-off: a role/status change only takes effect on the user's next
// login, within the 12h token TTL.)
function signSession(actor: Actor, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ userId: actor.id, expiresAt, actor })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseSession(token: string): { userId: string; expiresAt: number; actor?: Actor } | null {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as { userId: string; expiresAt: number; actor?: Actor };
  } catch {
    return null;
  }
}

export function toActor(user: User): Actor {
  return {
    id: user.id,
    role: user.role,
    displayName: user.displayName,
    grade: (user.grade ?? null) as Grade | null,
    quad: (user.quad ?? null) as Quad | null,
    gender: deriveActorGender(user),
  };
}

export function toSafeUser(user: User): SafeUser {
  const { passwordHash: _pw, ...safe } = user;
  return safe as SafeUser;
}

export interface AuthService {
  login(input: unknown): Promise<{ token: string; user: SafeUser }>;
  resolveToken(token: string): Promise<Actor | null>;
  logout(token: string): Promise<void>;
}

export function makeAuthService(users: IUserRepository): AuthService {
  return {
    async login(input: unknown) {
      const parsed = LoginInputSchema.safeParse(input);
      if (!parsed.success) throw new UnauthorizedError('Invalid credentials');

      const { email, password } = parsed.data;
      const user = await users.findByEmail(email);
      if (!user || user.status !== 'active') throw new UnauthorizedError('Invalid credentials');
      if (!user.passwordHash) throw new UnauthorizedError('Account has no password set');

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) throw new UnauthorizedError('Invalid credentials');

      // Silently upgrade legacy SHA-256 hashes to bcrypt on first login
      if (needsRehash(user.passwordHash)) {
        const newHash = await hashPassword(password);
        await users.save({ ...user, passwordHash: newHash, updatedAt: new Date().toISOString() });
      }

      const token = signSession(toActor(user), Date.now() + TOKEN_TTL_MS);
      return { token, user: toSafeUser(user) };
    },

    async resolveToken(token: string) {
      const session = parseSession(token);
      if (!session) return null;
      if (Date.now() > session.expiresAt) return null;
      // Trusted actor embedded in the signed token — no DB round-trip needed.
      if (session.actor) return session.actor;
      // Legacy token without an embedded actor: fall back to a lookup.
      const user = await users.findById(session.userId);
      if (!user || user.status !== 'active') return null;
      return toActor(user);
    },

    async logout(_token: string) {
      // Stateless tokens — logout is handled client-side by discarding the token
    },
  };
}
