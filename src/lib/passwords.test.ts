/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import app from '../index';
import type { AppEnv } from './http';
import { expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';

it('genera y verifica hashes PBKDF2 de 600 000 iteraciones', async () => {
  const password = 'contraseña de prueba';
  const hash = await hashPassword(password);

  expect(hash).toMatch(/^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  await expect(verifyPassword(password, hash)).resolves.toBe(true);
  await expect(verifyPassword('incorrecta', hash)).resolves.toBe(false);
});

it('valida un hash de 100 000 iteraciones y lo reescribe al iniciar sesión', async () => {
  const bindings = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
  const { DB } = bindings;
  const password = 'solo-prueba-local';
  const legacy = 'pbkdf2-sha256$100000$01010101010101010101010101010101$1dc845a7b41b3d862fab1c698cd92df3378dd528f61379737cfff14f41ba5baf';
  await expect(verifyPassword(password, legacy)).resolves.toBe(true);
  await applyD1Migrations(DB, bindings.TEST_MIGRATIONS);
  await DB.prepare('INSERT INTO admins (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .bind('legacy', 'legacy@example.test', legacy, 'agent').run();

  const response = await app.request('https://portofino.example.test/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'legacy@example.test', password }),
  }, { ...bindings, ADMIN_SESSION_SECRET: 'firma exclusiva de prueba de más de 32 caracteres' });

  expect(response.status).toBe(200);
  expect(response.headers.get('Set-Cookie')).toContain('__Host-admin_session=');
  const migrated = await DB.prepare('SELECT password_hash FROM admins WHERE id = ?')
    .bind('legacy').first<string>('password_hash');
  expect(migrated?.split('$')[1]).toBe('600000');
  await expect(verifyPassword(password, migrated ?? undefined)).resolves.toBe(true);
});
