import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, MiddlewareHandler } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import { admins } from '../db/schema';
import { HttpError } from './errors';
import type { AppEnv } from './http';
import { verifyPassword } from './passwords';

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

export async function loginAgent(context: Context<AppEnv>, email: string, password: string) {
  const secret = signingSecret(context);
  const [admin] = await drizzle(context.env.DB).select().from(admins)
    .where(eq(admins.email, email.toLowerCase())).limit(1);
  const valid = await verifyPassword(password, admin?.passwordHash);
  if (!admin || !valid || admin.totpSecret !== null) {
    throw new HttpError(401, 'invalid_credentials', 'Credenciales inválidas');
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
    totpSecret: admins.totpSecret,
  }).from(admins).where(eq(admins.id, session.adminId)).limit(1);
  if (!admin || admin.totpSecret !== null) {
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
