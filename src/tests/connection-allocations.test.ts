import { describe, it, expect } from 'vitest';
import { can } from '../services/access-control';
import type { Actor } from '../core/entities/user';

function actor(role: string): Actor {
  return { id: 'a', role: role as any, displayName: 'T', grade: null as any, quad: null as any };
}

describe('connection:import capability', () => {
  it('is granted to admin only', () => {
    expect(can(actor('admin'), 'connection:import')).toBe(true);
    expect(can(actor('director'), 'connection:import')).toBe(false);
    expect(can(actor('quad'), 'connection:import')).toBe(false);
    expect(can(actor('grade'), 'connection:import')).toBe(false);
  });
});
