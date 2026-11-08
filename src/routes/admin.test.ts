/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import type { AppEnv } from '../lib/http';
import { hashPassword } from '../lib/passwords';

const bindings = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
const testBindings = { ...bindings, ADMIN_SESSION_SECRET: 'firma exclusiva de prueba de más de 32 caracteres' };
const db = bindings.DB;
const password = 'contraseña exclusiva de prueba';
const eightHours = 8 * 60 * 60 * 1000;

function jsonRequest(path: string, method: 'POST' | 'PATCH', body: unknown, cookie?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookie) headers.set('Cookie', cookie);
  return app.request('https://portofino.example.test' + path, {
    method, headers, body: JSON.stringify(body),
  }, testBindings);
}

async function login(role: 'owner' | 'agent') {
  const response = await jsonRequest('/admin/login', 'POST', {
    email: role + '@example.test', password,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie');
  expect(cookie).toBeTruthy();
  if (!cookie) throw new Error('Falta la cookie de sesión');
  return { response, cookie, credential: cookie.split(';', 1)[0]! };
}

function changeStatus(status: string, cookie: string) {
  return jsonRequest('/admin/orders/1/status', 'PATCH', { status }, cookie);
}

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  const digest = await hashPassword(password);
  await db.batch(['owner', 'agent'].map((role) => db.prepare(
    'INSERT INTO admins (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
  ).bind(role, role + '@example.test', digest, role)));
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM audit_log'),
    db.prepare('DELETE FROM orders'),
    db.prepare(`
      INSERT INTO orders (id, number, tracking_token_hash, buyer_name, buyer_email_enc,
        buyer_phone_enc, ship_address_enc, created_at, updated_at)
      VALUES ('order-1', 1, 'test-hash', 'Cliente ficticio', 'test', 'test', 'test', 1, 1)
    `),
  ]);
});

describe('autenticación y transiciones administrativas', () => {
  it('devuelve 403 al agente que intenta cancelar y registra la cancelación del owner', async () => {
    const agent = await login('agent');
    expect((await changeStatus('cancelled', agent.credential)).status).toBe(403);
    expect(await db.prepare('SELECT status FROM orders').first('status')).toBe('pending_confirmation');
    expect(await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first('total')).toBe(0);

    const owner = await login('owner');
    expect((await changeStatus('cancelled', owner.credential)).status).toBe(200);
    expect(await db.prepare('SELECT status, version FROM orders').first())
      .toEqual({ status: 'cancelled', version: 2 });
    expect(await db.prepare('SELECT * FROM audit_log').first()).toMatchObject({
      admin_id: 'owner', entity_id: 'order-1', action: 'status_changed',
      from_status: 'pending_confirmation', to_status: 'cancelled',
    });
  });

  it('audita una transición permitida del agente y revierte un cambio si falla la auditoría', async () => {
    const agent = await login('agent');
    expect((await changeStatus('confirmed', agent.credential)).status).toBe(200);
    expect(await db.prepare('SELECT admin_id, to_status FROM audit_log').first())
      .toEqual({ admin_id: 'agent', to_status: 'confirmed' });

    await db.prepare(`
      CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'fallo de prueba'); END
    `).run();
    try {
      expect((await changeStatus('packing', agent.credential)).status).toBe(500);
      expect(await db.prepare('SELECT status, version FROM orders').first())
        .toEqual({ status: 'confirmed', version: 2 });
      expect(await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first('total')).toBe(1);
    } finally {
      await db.prepare('DROP TRIGGER reject_audit').run();
    }
  });

  it('rechaza contraseña incorrecta y cookie alterada', async () => {
    const failed = await jsonRequest('/admin/login', 'POST', {
      email: 'owner@example.test', password: 'incorrecta',
    });
    expect(failed.status).toBe(401);
    expect(failed.headers.has('Set-Cookie')).toBe(false);
    const { credential } = await login('owner');
    expect((await changeStatus('confirmed', credential + 'x')).status).toBe(401);
  });

  it('emite una cookie segura y rechaza su uso al cumplirse ocho horas', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(now);
    try {
      const { response, cookie, credential } = await login('owner');
      expect(cookie).toContain('__Host-admin_session=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Max-Age=28800');
      await expect(response.json()).resolves.toEqual({
        role: 'owner', expiresAt: now.getTime() + eightHours,
      });

      vi.setSystemTime(now.getTime() + eightHours - 1);
      expect((await changeStatus('confirmed', credential)).status).toBe(200);
      vi.setSystemTime(now.getTime() + eightHours);
      expect((await changeStatus('packing', credential)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});
