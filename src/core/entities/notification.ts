import type { PushTarget } from './push-subscription';

export interface Notification {
  id: string;
  senderId: string;
  target: PushTarget;
  title: string;
  message: string;
  sent: number;
  failed: number;
  createdAt: string;
  expiresAt: string;
  deletedAt: string | null;
}

export interface NotificationRecipient {
  id: string;
  notificationId: string;
  recipientId: string;
  dismissedAt: string | null;
}

export type NotificationWithRecipient = Notification & { dismissedAt: string | null };
