import { describe, it, expect } from 'vitest';
import { makePrayerController } from '../api/controllers/prayer.controller';
import { UnauthorizedError } from '../core/errors/app-error';
import type { HttpRequest } from '../api/http/types';
import type { PrayerService } from '../services/prayer.service';

function noCtxReq(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { ctx: null, params: {}, query: {}, body: undefined, ...overrides };
}

// A minimal fake service whose every method throws if actually invoked — the
// controller's `if (!req.ctx) throw new UnauthorizedError()` guard must fire
// BEFORE any of these are called, so a passing test here proves the guard
// runs first, not just that the overall call rejected.
function makeUncalledService(): PrayerService {
  const fail = (): never => { throw new Error('PrayerService method should not be called when req.ctx is missing'); };
  return {
    list: fail, listByStudent: fail, create: fail, update: fail,
    setStatus: fail, remove: fail, exportCsv: fail, importCsv: fail,
  } as unknown as PrayerService;
}

describe('prayer controller — auth guard (no req.ctx)', () => {
  const ctrl = makePrayerController({ prayer: makeUncalledService() });

  it('list throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.list(noCtxReq())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('create throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.create(noCtxReq({ body: { text: 'x' } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('listByStudent throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.listByStudent(noCtxReq({ params: { studentId: 's1' } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('update throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.update(noCtxReq({ params: { id: 'p1' }, body: { text: 'x' } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('setStatus throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.setStatus(noCtxReq({ params: { id: 'p1' }, body: { status: 'answered' } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('remove throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.remove(noCtxReq({ params: { id: 'p1' } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('exportCsv throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.exportCsv(noCtxReq())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('importCsv throws UnauthorizedError with no ctx', async () => {
    await expect(ctrl.importCsv(noCtxReq({ body: { rows: [] } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
