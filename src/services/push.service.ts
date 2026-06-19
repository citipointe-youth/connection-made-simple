import webpush from 'web-push';
import type { Actor, SafeUser, User } from '../core/entities/user';
import type { PushSubscription, PushTarget } from '../core/entities/push-subscription';
import type { Notification, NotificationWithRecipient } from '../core/entities/notification';
import type {
  IPushSubscriptionRepository,
  INotificationRepository,
  IUserRepository,
} from '../repositories/interfaces/entity-repositories';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error';
import { quadGradesOf, quadGenderOf } from './access-control';
import { generateId } from '../utils/id';

// ── Pure functions (exported for testing) ───────────────────────────────────

export function canActorSendTo(actor: Actor, target: PushTarget): boolean {
  if (actor.role === 'admin' || actor.role === 'director') return true;
  if (actor.role !== 'quad') return false;
  const grades = quadGradesOf(actor.quad!);
  const gender = quadGenderOf(actor.quad!);
  switch (target.type) {
    case 'all': return false;
    case 'quad': return actor.quad === target.quad;
    case 'grade': return grades.includes(target.grade) && target.gender === gender;
  }
}

function deriveGenderFromEmail(email: string): 'male' | 'female' | null {
  const username = email.split('@')[0]?.toLowerCase() ?? '';
  if (username.endsWith('g') || username.includes('girl')) return 'female';
  if (username.endsWith('b') || username.includes('boy')) return 'male';
  return null;
}

export function getUsersForTarget(target: PushTarget, users: SafeUser[]): SafeUser[] {
  switch (target.type) {
    case 'all': return users;
    case 'quad': return users.filter((u) => u.role === 'quad' && u.quad === target.quad);
    case 'grade':
      return users.filter((u) => {
        if (u.role !== 'grade' || u.grade !== target.grade) return false;
        return deriveGenderFromEmail(u.email) === target.gender;
      });
  }
}

function toSafe(u: User): SafeUser {
  const { passwordHash: _pw, ...safe } = u;
  return safe as SafeUser;
}

// ── Service types ────────────────────────────────────────────────────────────

export interface SendResult {
  sent: number;
  failed: number;
}

export interface ReceivedNotification extends NotificationWithRecipient {
  senderName: string;
}

export interface NotificationsResponse {
  received: ReceivedNotification[];
  sent: Notification[];
}

export interface PushService {
  getVapidPublicKey(): string;
  subscribe(actor: Actor, endpoint: string, p256dh: string, auth: string): Promise<void>;
  unsubscribe(actor: Actor, endpoint: string): Promise<void>;
  send(actor: Actor, target: PushTarget, title: string, message: string): Promise<SendResult>;
  getNotificationsForUser(actor: Actor): Promise<NotificationsResponse>;
  deleteNotification(actor: Actor, id: string): Promise<void>;
  dismissNotification(actor: Actor, id: string): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makePushService(opts: {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  pushRepo: IPushSubscriptionRepository;
  notifRepo: INotificationRepository;
  userRepo: IUserRepository;
}): PushService {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject, pushRepo, notifRepo, userRepo } = opts;

  if (vapidPublicKey && vapidPrivateKey && vapidSubject) {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  }

  return {
    getVapidPublicKey() {
      return vapidPublicKey;
    },

    async subscribe(actor, endpoint, p256dh, auth) {
      const sub: PushSubscription = {
        id: generateId(),
        userId: actor.id,
        endpoint,
        p256dh,
        auth,
        createdAt: new Date().toISOString(),
      };
      await pushRepo.upsert(sub);
    },

    async unsubscribe(actor, endpoint) {
      await pushRepo.deleteByEndpoint(actor.id, endpoint);
    },

    async send(actor, target, title, message) {
      if (!canActorSendTo(actor, target)) {
        throw new ForbiddenError('You are not allowed to send to this target');
      }

      const allUsers = await userRepo.findAll();
      const safeUsers = allUsers.map(toSafe);
      const targetUsers = getUsersForTarget(target, safeUsers);
      const userIds = targetUsers.map((u) => u.id);
      const subs = await pushRepo.findByUserIds(userIds);

      const payload = JSON.stringify({
        title,
        body: message,
        icon: '/icons/icon.svg',
        badge: '/icons/icon.svg',
      });

      let sent = 0;
      let failed = 0;

      await Promise.all(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
            );
            sent++;
          } catch (err: unknown) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 410 || status === 404) {
              await pushRepo.deleteByEndpoint(sub.userId, sub.endpoint);
            }
            failed++;
          }
        }),
      );

      const now = new Date().toISOString();
      const notif: Notification = {
        id: generateId(),
        senderId: actor.id,
        target,
        title,
        message,
        sent,
        failed,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        deletedAt: null,
      };
      await notifRepo.save(notif);
      await notifRepo.saveRecipients(notif.id, userIds);

      return { sent, failed };
    },

    async getNotificationsForUser(actor) {
      const canSend = actor.role === 'admin' || actor.role === 'director' || actor.role === 'quad';
      const [received, sentRaw, allUsers] = await Promise.all([
        notifRepo.findReceivedByUser(actor.id),
        canSend ? notifRepo.findSentByUser(actor.id) : Promise.resolve([]),
        userRepo.findAll(),
      ]);
      const nameById = new Map(allUsers.map((u) => [u.id, u.displayName]));
      return {
        received: received.map((n) => ({
          ...n,
          senderName: nameById.get(n.senderId) ?? 'Unknown',
        })),
        sent: sentRaw,
      };
    },

    async deleteNotification(actor, id) {
      const notif = await notifRepo.findById(id);
      if (!notif) throw new NotFoundError('Notification not found');
      if (notif.senderId !== actor.id) {
        throw new ForbiddenError('You can only delete notifications you sent');
      }
      await notifRepo.softDelete(id, new Date().toISOString());
    },

    async dismissNotification(actor, id) {
      await notifRepo.dismissForUser(id, actor.id, new Date().toISOString());
    },
  };
}
