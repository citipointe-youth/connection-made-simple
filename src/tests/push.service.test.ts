import { describe, it, expect, vi } from 'vitest';
import { canActorSendTo, getUsersForTarget, makePushService } from '../services/push.service';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error';
import type { Actor, SafeUser } from '../core/entities/user';
import type { PushTarget } from '../core/entities/push-subscription';

function actor(role: string, opts: { quad?: string; grade?: number } = {}): Actor {
  return {
    id: 'test', role: role as any, displayName: 'Test',
    grade: (opts.grade ?? null) as any,
    quad: (opts.quad ?? null) as any,
    gender: null,
  };
}

function user(id: string, opts: { role: string; grade?: number; quad?: string; email?: string }): SafeUser {
  return {
    id,
    displayName: 'Test',
    email: opts.email ?? `${id}@example.com`,
    role: opts.role as any,
    grade: (opts.grade ?? null) as any,
    quad: (opts.quad ?? null) as any,
    status: 'active',
    createdAt: '',
    updatedAt: '',
  };
}

// ── canActorSendTo ───────────────────────────────────────────────────────────

describe('canActorSendTo', () => {
  it('admin can send to any target', () => {
    const a = actor('admin');
    expect(canActorSendTo(a, { type: 'all' })).toBe(true);
    expect(canActorSendTo(a, { type: 'quad', quad: 'g79' })).toBe(true);
    expect(canActorSendTo(a, { type: 'grade', grade: 7, gender: 'female' })).toBe(true);
  });

  it('director can send to any target', () => {
    const a = actor('director');
    expect(canActorSendTo(a, { type: 'all' })).toBe(true);
    expect(canActorSendTo(a, { type: 'quad', quad: 'b1012' })).toBe(true);
    expect(canActorSendTo(a, { type: 'grade', grade: 12, gender: 'male' })).toBe(true);
  });

  it('quad cannot send to "all"', () => {
    expect(canActorSendTo(actor('quad', { quad: 'g79' }), { type: 'all' })).toBe(false);
  });

  it('quad can send to their own quad', () => {
    const a = actor('quad', { quad: 'g79' });
    expect(canActorSendTo(a, { type: 'quad', quad: 'g79' })).toBe(true);
    expect(canActorSendTo(a, { type: 'quad', quad: 'b79' })).toBe(false);
    expect(canActorSendTo(a, { type: 'quad', quad: 'g1012' })).toBe(false);
  });

  it('quad can send to grades in their bracket + gender only', () => {
    const g79 = actor('quad', { quad: 'g79' });
    expect(canActorSendTo(g79, { type: 'grade', grade: 7, gender: 'female' })).toBe(true);
    expect(canActorSendTo(g79, { type: 'grade', grade: 9, gender: 'female' })).toBe(true);
    expect(canActorSendTo(g79, { type: 'grade', grade: 10, gender: 'female' })).toBe(false);
    expect(canActorSendTo(g79, { type: 'grade', grade: 7, gender: 'male' })).toBe(false);

    const b1012 = actor('quad', { quad: 'b1012' });
    expect(canActorSendTo(b1012, { type: 'grade', grade: 10, gender: 'male' })).toBe(true);
    expect(canActorSendTo(b1012, { type: 'grade', grade: 12, gender: 'male' })).toBe(true);
    expect(canActorSendTo(b1012, { type: 'grade', grade: 9, gender: 'male' })).toBe(false);
    expect(canActorSendTo(b1012, { type: 'grade', grade: 10, gender: 'female' })).toBe(false);
  });

  it('grade login cannot send', () => {
    const a = actor('grade', { grade: 7 });
    expect(canActorSendTo(a, { type: 'all' })).toBe(false);
    expect(canActorSendTo(a, { type: 'grade', grade: 7, gender: 'female' })).toBe(false);
  });
});

// ── getUsersForTarget ────────────────────────────────────────────────────────

describe('getUsersForTarget', () => {
  const users: SafeUser[] = [
    user('admin1',  { role: 'admin',    email: 'admin@y.m' }),
    user('dir1',    { role: 'director', email: 'director@y.m' }),
    user('qg79',    { role: 'quad',     quad: 'g79',   email: 'g79@y.m' }),
    user('qb79',    { role: 'quad',     quad: 'b79',   email: 'b79@y.m' }),
    user('qg1012',  { role: 'quad',     quad: 'g1012', email: 'g1012@y.m' }),
    user('qb1012',  { role: 'quad',     quad: 'b1012', email: 'b1012@y.m' }),
    user('g7f',     { role: 'grade', grade: 7,  email: 'grade7g@y.m' }),
    user('g7m',     { role: 'grade', grade: 7,  email: 'grade7b@y.m' }),
    user('g9f',     { role: 'grade', grade: 9,  email: 'grade9g@y.m' }),
    user('g12m',    { role: 'grade', grade: 12, email: 'grade12b@y.m' }),
  ];

  it('all → returns every user', () => {
    expect(getUsersForTarget({ type: 'all' }, users)).toHaveLength(users.length);
  });

  it('quad g79 → returns the quad login plus its gendered grade logins', () => {
    const result = getUsersForTarget({ type: 'quad', quad: 'g79' }, users);
    const ids = result.map((u) => u.id).sort();
    // qg79 (quad) + g7f (grade7g) + g9f (grade9g); excludes male/other-bracket grades.
    expect(ids).toEqual(['g7f', 'g9f', 'qg79']);
    expect(ids).not.toContain('g7m');
    expect(ids).not.toContain('g12m');
    expect(ids).not.toContain('qb79');
  });

  it('grade 7 female → returns only g7f', () => {
    const result = getUsersForTarget({ type: 'grade', grade: 7, gender: 'female' }, users);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('g7f');
  });

  it('grade 7 male → returns only g7m', () => {
    const result = getUsersForTarget({ type: 'grade', grade: 7, gender: 'male' }, users);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('g7m');
  });

  it('grade with no gender suffix is excluded from gendered targets', () => {
    const u = [user('g7none', { role: 'grade', grade: 7, email: 'grade7@y.m' })];
    expect(getUsersForTarget({ type: 'grade', grade: 7, gender: 'female' }, u)).toHaveLength(0);
  });
});

// ── send + notification logging ──────────────────────────────────────────────

describe('makePushService.send', () => {
  it('throws ForbiddenError when grade login tries to send', async () => {
    const svc = makePushService({
      vapidPublicKey: '', vapidPrivateKey: '', vapidSubject: '',
      pushRepo: null as any, notifRepo: null as any, userRepo: null as any,
    });
    await expect(
      svc.send(actor('grade', { grade: 7 }), { type: 'all' }, 'T', 'M'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('returns { sent: 0, failed: 0 } and saves a notification record when no devices subscribed', async () => {
    const savedNotif = { current: null as any };

    const mockPushRepo = {
      init: vi.fn(), findByUserId: vi.fn(),
      findByUserIds: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(), deleteByEndpoint: vi.fn(), deleteByUserId: vi.fn(),
    };
    const mockNotifRepo = {
      init: vi.fn(),
      save: vi.fn().mockImplementation(async (n: any) => { savedNotif.current = n; return n; }),
      saveRecipients: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn(), findSentByUser: vi.fn(), findReceivedByUser: vi.fn(),
      softDelete: vi.fn(), dismissForUser: vi.fn(),
    };
    const mockUserRepo = {
      init: vi.fn(),
      findAll: vi.fn().mockResolvedValue([]),
      findById: vi.fn(), findByEmail: vi.fn(), findByRole: vi.fn(),
      save: vi.fn(), delete: vi.fn(),
    };

    const svc = makePushService({
      vapidPublicKey: '', vapidPrivateKey: '', vapidSubject: '',
      pushRepo: mockPushRepo as any,
      notifRepo: mockNotifRepo as any,
      userRepo: mockUserRepo as any,
    });

    const result = await svc.send(actor('admin'), { type: 'all' }, 'Title', 'Hello');
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(mockNotifRepo.save).toHaveBeenCalledOnce();
    expect(savedNotif.current.title).toBe('Title');
    expect(savedNotif.current.message).toBe('Hello');
    expect(savedNotif.current.senderId).toBe('test');
    expect(savedNotif.current.deletedAt).toBeNull();
  });
});

// ── deleteNotification ───────────────────────────────────────────────────────

describe('makePushService.deleteNotification', () => {
  function makeRepos(notif: any) {
    return {
      pushRepo: null as any,
      notifRepo: {
        init: vi.fn(),
        save: vi.fn(), saveRecipients: vi.fn(),
        findById: vi.fn().mockResolvedValue(notif),
        findSentByUser: vi.fn(), findReceivedByUser: vi.fn(),
        softDelete: vi.fn().mockResolvedValue(undefined),
        dismissForUser: vi.fn(),
      },
      userRepo: null as any,
    };
  }

  it('throws ForbiddenError when non-sender tries to delete', async () => {
    const repos = makeRepos({ id: 'n1', senderId: 'other-user' });
    const svc = makePushService({ vapidPublicKey: '', vapidPrivateKey: '', vapidSubject: '', ...repos });
    await expect(svc.deleteNotification(actor('admin'), 'n1')).rejects.toThrow(ForbiddenError);
  });

  it('calls softDelete when sender deletes their notification', async () => {
    const repos = makeRepos({ id: 'n1', senderId: 'test' });
    const svc = makePushService({ vapidPublicKey: '', vapidPrivateKey: '', vapidSubject: '', ...repos });
    await svc.deleteNotification(actor('admin'), 'n1');
    expect(repos.notifRepo.softDelete).toHaveBeenCalledWith('n1', expect.any(String));
  });

  it('throws NotFoundError for unknown id', async () => {
    const repos = makeRepos(null);
    const svc = makePushService({ vapidPublicKey: '', vapidPrivateKey: '', vapidSubject: '', ...repos });
    await expect(svc.deleteNotification(actor('admin'), 'bad')).rejects.toThrow(NotFoundError);
  });
});
