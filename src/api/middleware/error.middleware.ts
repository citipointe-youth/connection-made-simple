import type { Response } from 'express';
import { AppError } from '../../core/errors/app-error';
import { ZodError } from 'zod';

// Transient DB / connection failures — surface as 503 (retryable) rather than 500
// so logs and monitoring separate infra hiccups (cold/exhausted pooler, dropped
// connection, statement timeout) from real bugs. The SPA treats both as a failed
// fetch, so user-facing behaviour is unchanged. Codes cover Node socket errors,
// the porsager driver's connection codes, and Postgres SQLSTATE class 08 + a few
// transient server states.
const TRANSIENT_DB_CODES = new Set([
  'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  '08000', '08001', '08003', '08004', '08006', // class 08 — connection exception
  '53300', // too_many_connections (pool/connection-limit exhaustion)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
]);
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_DB_CODES.has(code);
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ code: err.code, message: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: err.errors,
    });
    return;
  }
  if (isTransientDbError(err)) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Transient DB error (503):', msg);
    res.status(503).json({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service is temporarily unavailable. Please try again.',
    });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Unhandled error:', err instanceof Error ? (err.stack ?? msg) : msg);
  const clientMsg = process.env['NODE_ENV'] === 'production' ? 'An unexpected error occurred' : msg;
  res.status(500).json({ code: 'INTERNAL_ERROR', message: clientMsg });
}
