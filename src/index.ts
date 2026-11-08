import { Hono } from 'hono';
import { handleError } from './lib/http';
import type { AppEnv } from './lib/http';
import { adminRoutes } from './routes/admin';
import { panelRoutes } from './routes/panel';
import { publicRoutes } from './routes/public';

const app = new Hono<AppEnv>();

app.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('X-Content-Type-Options', 'nosniff');
  await next();
});

app.onError(handleError);
app.notFound((context) => context.json({
  error: { code: 'not_found', message: 'Ruta no encontrada' },
}, 404));
app.route('/', publicRoutes);
app.route('/admin', adminRoutes);
app.route('/', panelRoutes);

export { OrderRoom } from './durable/order-room';
export default app;
