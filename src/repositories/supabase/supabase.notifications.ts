import type { SqlClient } from './client';
import type { INotificationRepository } from '../interfaces/entity-repositories';
import type { Notification, NotificationWithRecipient } from '../../core/entities/notification';
import type { PushTarget } from '../../core/entities/push-subscription';
import { generateId } from '../../utils/id';

function toNotification(row: Record<string, unknown>): Notification {
  return {
    id: row['id'] as string,
    senderId: row['sender_id'] as string,
    target: (typeof row['target'] === 'string'
      ? JSON.parse(row['target'])
      : row['target']) as PushTarget,
    title: row['title'] as string,
    message: row['message'] as string,
    sent: row['sent'] as number,
    failed: row['failed'] as number,
    createdAt: (row['created_at'] as Date).toISOString(),
    expiresAt: (row['expires_at'] as Date).toISOString(),
    deletedAt: row['deleted_at'] ? (row['deleted_at'] as Date).toISOString() : null,
  };
}

export class SupabaseNotificationRepository implements INotificationRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {}

  async save(notification: Notification): Promise<Notification> {
    const rows = await this.sql`
      insert into notifications
        (id, sender_id, target, title, message, sent, failed, created_at, expires_at, deleted_at)
      values
        (${notification.id}, ${notification.senderId}, ${JSON.stringify(notification.target)},
         ${notification.title}, ${notification.message}, ${notification.sent}, ${notification.failed},
         ${notification.createdAt}, ${notification.expiresAt}, ${notification.deletedAt ?? null})
      on conflict (id) do update set
        sent       = excluded.sent,
        failed     = excluded.failed,
        deleted_at = excluded.deleted_at
      returning *
    `;
    return toNotification(rows[0]!);
  }

  async saveRecipients(notificationId: string, recipientIds: string[]): Promise<void> {
    if (recipientIds.length === 0) return;
    const rows = recipientIds.map((rid) => ({
      id: generateId(),
      notification_id: notificationId,
      recipient_id: rid,
      dismissed_at: null,
    }));
    await this.sql`
      insert into notification_recipients ${this.sql(rows)}
      on conflict (notification_id, recipient_id) do nothing
    `;
  }

  async findById(id: string): Promise<Notification | null> {
    const rows = await this.sql`select * from notifications where id = ${id}`;
    return rows[0] ? toNotification(rows[0]) : null;
  }

  async findSentByUser(userId: string): Promise<Notification[]> {
    const rows = await this.sql`
      select * from notifications
      where sender_id = ${userId}
        and deleted_at is null
        and expires_at > now()
      order by created_at desc
      limit 50
    `;
    return rows.map(toNotification);
  }

  async findReceivedByUser(userId: string): Promise<NotificationWithRecipient[]> {
    const rows = await this.sql`
      select n.*, nr.dismissed_at as recipient_dismissed_at
      from notifications n
      join notification_recipients nr on nr.notification_id = n.id
      where nr.recipient_id = ${userId}
        and n.deleted_at is null
        and n.expires_at > now()
        and nr.dismissed_at is null
      order by n.created_at desc
      limit 50
    `;
    return rows.map((row) => ({
      ...toNotification(row),
      dismissedAt: row['recipient_dismissed_at']
        ? (row['recipient_dismissed_at'] as Date).toISOString()
        : null,
    }));
  }

  async softDelete(id: string, deletedAt: string): Promise<void> {
    await this.sql`
      update notifications set deleted_at = ${deletedAt} where id = ${id}
    `;
  }

  async dismissForUser(notificationId: string, userId: string, dismissedAt: string): Promise<void> {
    await this.sql`
      update notification_recipients
      set dismissed_at = ${dismissedAt}
      where notification_id = ${notificationId} and recipient_id = ${userId}
    `;
  }
}
