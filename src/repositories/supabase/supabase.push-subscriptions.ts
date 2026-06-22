import type { SqlClient } from './client';
import { toIso } from './client';
import type { IPushSubscriptionRepository } from '../interfaces/entity-repositories';
import type { PushSubscription } from '../../core/entities/push-subscription';
import { generateId } from '../../utils/id';

function toSub(row: Record<string, unknown>): PushSubscription {
  return {
    id: row['id'] as string,
    userId: row['user_id'] as string,
    endpoint: row['endpoint'] as string,
    p256dh: row['p256dh'] as string,
    auth: row['auth'] as string,
    createdAt: toIso(row['created_at']),
  };
}

export class SupabasePushSubscriptionRepository implements IPushSubscriptionRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {}

  async findByUserId(userId: string): Promise<PushSubscription[]> {
    const rows = await this.sql`
      select * from push_subscriptions where user_id = ${userId}
    `;
    return rows.map(toSub);
  }

  async findByUserIds(userIds: string[]): Promise<PushSubscription[]> {
    if (userIds.length === 0) return [];
    const rows = await this.sql`
      select * from push_subscriptions where user_id = any(${userIds})
    `;
    return rows.map(toSub);
  }

  async upsert(sub: PushSubscription): Promise<PushSubscription> {
    const rows = await this.sql`
      insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
      values (${sub.id}, ${sub.userId}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth}, ${sub.createdAt})
      on conflict (user_id, endpoint) do update set
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        created_at = excluded.created_at
      returning *
    `;
    return toSub(rows[0]!);
  }

  async deleteByEndpoint(userId: string, endpoint: string): Promise<void> {
    await this.sql`
      delete from push_subscriptions
      where user_id = ${userId} and endpoint = ${endpoint}
    `;
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.sql`delete from push_subscriptions where user_id = ${userId}`;
  }
}
