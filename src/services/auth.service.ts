import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { verifyPassword } from '../utils/crypto';
import type { IUserRepository } from '../repositories/interfaces/entity-repositories';
import type { Actor, User, SafeUser } from '../core/entities/user';
import type { Grade, Quad } from '../core/types/enums';
import { UnauthorizedError } from '../core/errors/app-error';
import { LoginInputSchema } from '../core/validation/auth.schema';

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

function signSession(userId: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ userId, expiresAt })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseSession(token: string): { userId: string; expiresAt: number } | null {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as { userId: string; expiresAt: number };
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

      const token = signSession(user.id, Date.now() + TOKEN_TTL_MS);
      return { token, user: toSafeUser(user) };
    },

    async resolveToken(token: string) {
      const session = parseSession(token);
      if (!session) return null;
      if (Date.now() > session.expiresAt) return null;
      const user = await users.findById(session.userId);
      if (!user || user.status !== 'active') return null;
      return toActor(user);
    },

    async logout(_token: string) {
      // Stateless tokens — logout is handled client-side by discarding the token
    },
  };
}
