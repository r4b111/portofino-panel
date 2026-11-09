import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, MiddlewareHandler } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import { admins } from '../db/schema';
import { HttpError } from './errors';
import type { AppEnv } from './http';
import { loginIsLimited, loginLimitKeys, recordLoginFailure } from './login-limit';
import { hashPassword, verifyPassword } from './passwords';
import { matchingTotpStep } from './totp';

export const loginCredentials = z.object({
  email: z.string().trim().max(254).email(),
  password: z.string().min(1).max(256),
  totp: z.string().max(256).optional(),
});

const sessionName = '__Host-admin_session';
const sessionSeconds = 8 * 60 * 60;
const sessionSchema = z.object({ adminId: z.string().min(1), expiresAt: z.number().int() });

function signingSecret(context: Context<AppEnv>): string {
  const secret = context.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.trim().length < 32) {
    throw new HttpError(503, 'admin_unavailable', 'Acceso administrativo sin configurar');
  }
  return secret;
}

export async function loginAgent(context: Context<AppEnv>, email: string, password: string, totp?: string) {
  const secret = signingSecret(context);
  const normalizedEmail = email.toLowerCase();
  const database = context.env.DB;
  const ip = context.req.header('CF-Connecting-IP') ?? 'unavailable';
  const keys = await loginLimitKeys(secret, normalizedEmail, ip);
  const limitError = () => new HttpError(429, 'login_rate_limited', 'Demasiados intentos. Inténtalo más tarde');
  if (await loginIsLimited(database, keys)) throw limitError();

  const rejectLogin = async (code: string, message: string): Promise<never> => {
    if (!await recordLoginFailure(database, keys)) throw limitError();
    throw new HttpError(401, code, message);
  };
  const db = drizzle(database);
  const [admin] = await db.select().from(admins).where(eq(admins.email, normalizedEmail)).limit(1);
  const valid = await verifyPassword(password, admin?.passwordHash);
  if (!admin || !valid) {
    return rejectLogin('invalid_credentials', 'Credenciales inválidas');
  }

  if (admin.totpSecret !== null) {
    const step = await matchingTotpStep(admin.totpSecret, totp, Date.now());
    if (step === null) return rejectLogin('totp_required', 'Ingresa un código de autenticación válido');
    const accepted = await database.prepare(`
      INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start
      WHERE rate_limits.window_start < excluded.window_start
    `).bind('totp:' + admin.id, step).run();
    if (accepted.meta.changes !== 1) {
      return rejectLogin('totp_required', 'Ingresa un código de autenticación válido');
    }
  }

  if (admin.passwordHash.startsWith('pbkdf2-sha256$100000$')) {
    await db.update(admins).set({ passwordHash: await hashPassword(password) })
      .where(and(eq(admins.id, admin.id), eq(admins.passwordHash, admin.passwordHash)));
  }

  const expiresAt = Date.now() + sessionSeconds * 1000;
  await setSignedCookie(context, sessionName, JSON.stringify({ adminId: admin.id, expiresAt }), secret, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: sessionSeconds,
  });
  return { role: admin.role, expiresAt };
}

export const requireAgent: MiddlewareHandler<AppEnv> = async (context, next) => {
  const signed = await getSignedCookie(context, signingSecret(context), sessionName);
  let session: z.infer<typeof sessionSchema> | undefined;
  if (typeof signed === 'string') {
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(signed));
      if (parsed.success) session = parsed.data;
    } catch {
      // Malformed session cookies are handled as unauthenticated requests.
    }
  }

  if (!session || session.expiresAt <= Date.now()) {
    throw new HttpError(401, 'unauthorized', 'Inicia sesión para continuar');
  }
  const [admin] = await drizzle(context.env.DB).select({
    id: admins.id,
    role: admins.role,
  }).from(admins).where(eq(admins.id, session.adminId)).limit(1);
  if (!admin) {
    throw new HttpError(401, 'unauthorized', 'Inicia sesión para continuar');
  }

  context.set('agent', { id: admin.id, role: admin.role, expiresAt: session.expiresAt });
  await next();
};

export function requireRole(role: 'owner' | 'agent'): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (context.get('agent')?.role !== role) {
      throw new HttpError(403, 'forbidden', 'No tienes permiso para esta acción');
    }
    await next();
  };
}
