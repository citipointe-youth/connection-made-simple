export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

export type PushTarget =
  | { type: 'all' }
  | { type: 'quad'; quad: string }
  | { type: 'grade'; grade: number; gender: 'male' | 'female' };
