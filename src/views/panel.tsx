import type { Child } from 'hono/jsx';
import { html, raw } from 'hono/html';
import type { TransitionDraft } from '../lib/http';
import type { findPanelOrder, listPanelOrders } from '../lib/orders/service';
import { allowedTransitions, orderStatuses } from '../lib/orders/state';
import type { OrderStatus } from '../lib/orders/state';
import { OrderChat } from './order-chat';

const statusLabels: Record<OrderStatus, string> = {
  pending_confirmation: 'Pendiente de confirmación',
  confirmed: 'Confirmado',
  packing: 'En preparación',
  shipped: 'Enviado',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  returned: 'Devuelto',
  expired: 'Vencido',
};

const actions: Record<OrderStatus, string> = {
  pending_confirmation: 'Marcar pendiente',
  confirmed: 'Confirmar pedido',
  packing: 'Iniciar preparación',
  shipped: 'Marcar enviado',
  delivered: 'Marcar entregado',
  cancelled: 'Cancelar pedido',
  returned: 'Registrar devolución',
  expired: 'Marcar vencido',
};

const events: Record<string, string> = {
  created: 'Pedido creado',
  status_changed: 'Estado actualizado',
  payment_changed: 'Pago actualizado',
  items_changed: 'Ítems actualizados',
  note: 'Nota registrada',
  anonymized: 'Datos anonimizados',
};

const paymentLabels = {
  unpaid: 'Sin pagar', paid: 'Pagado', cod_pending: 'Contraentrega pendiente',
  cod_collected: 'Contraentrega cobrada', refunded: 'Reembolsado',
} as const;

const paymentScript = `
(() => {
  const button = document.querySelector('[data-payment-action]');
  const alert = document.querySelector('[data-payment-alert]');
  const feedback = document.querySelector('[data-payment-feedback]');
  button.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    feedback.hidden = true;
    try {
      const response = await fetch(button.dataset.paymentUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentStatus: button.dataset.paymentAction,
          expectedVersion: Number(button.dataset.paymentVersion),
        }),
      });
      if (response.status === 200) {
        window.location.reload();
        return;
      }
      if (response.status === 409) {
        const { error } = await response.json();
        alert.querySelector('[data-conflict-message]').textContent = error.message;
        alert.hidden = false;
        return;
      }
    } catch {
      // A network error leaves the action available to retry.
    }
    feedback.hidden = false;
    button.disabled = false;
  });
})();
`;

const panelCss = `
:root{color-scheme:light;font:16px system-ui,sans-serif;color:#183a30;background:#f7f6ef}
body{margin:0}header{background:#153f33;color:#fff;padding:1rem max(5%,calc((100% - 68rem)/2))}
header a{color:inherit;text-decoration:none;font-weight:750;letter-spacing:.08em}
main{max-width:68rem;margin:2rem auto;padding:0 1rem}h1{font-size:clamp(1.65rem,4vw,2.5rem)}
h2{font-size:1.18rem}a{color:#14513d}.card{background:#fff;border:1px solid #d8e0d9;
border-radius:.75rem;padding:1rem 1.2rem;margin:1rem 0}.login{max-width:27rem}
label{display:grid;gap:.4rem}input,select,button{font:inherit;border-radius:.45rem;padding:.65rem .8rem}
input,select{border:1px solid #71847a;background:#fff;color:#183a30}button{border:1px solid #155643;
background:#155643;color:#fff;cursor:pointer}button.danger{background:#fff;color:#8c2926;border-color:#8c2926}
button:disabled{opacity:.6;cursor:default}.stack{display:grid;gap:1rem}.row{display:flex;
align-items:end;gap:.75rem;flex-wrap:wrap}.scroll{overflow:auto}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.75rem;border-bottom:1px solid #d8e0d9;white-space:nowrap}
.pager{display:flex;flex-wrap:wrap;gap:1rem;align-items:center;margin:1rem 0}
.alert{border-left:.3rem solid #a34315;padding:.8rem 1rem;background:#fff0dc}
:focus-visible{outline:3px solid #93600b;outline-offset:3px}small{color:#3d584e}
`;

function Page({ title, children }: { title: string; children: Child }) {
  return <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} | Portofino</title>
      <style>{raw(panelCss)}</style>
    </head>
    <body>
      <header><a href="/pedidos">PORTOFINO · Pedidos</a></header>
      <main><h1>{title}</h1>{children}</main>
    </body>
  </html>;
}

export function loginPage(email = '', error = '', code?: string) {
  return html`<!doctype html>${<Page title="Iniciar sesión">
    <form class="card login stack" method="post" action="/login">
      {error && <p role="alert" class="alert" data-error-code={code}>{error}</p>}
      <label>Correo electrónico<input name="email" type="email" value={email}
        autocomplete="username" maxlength={254} required /></label>
      <label>Contraseña<input name="password" type="password"
        autocomplete="current-password" maxlength={256} required /></label>
      <label>Código de autenticación (si está activado)
          <input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength={6} pattern="[0-9]{6}" />
        </label>
        <button type="submit">Entrar</button>
    </form>
  </Page>}`;
}

export function panelError(message: string) {
  return html`<!doctype html>${<Page title="No se pudo completar la solicitud">
    <p role="alert" class="alert">{message}</p><a href="/pedidos">Volver a pedidos</a>
  </Page>}`;
}

function amount(value: number | null, currency: string) {
  if (value === null) return 'Por confirmar';
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(value) + ' ' + currency;
}

function date(time: number) {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota',
  }).format(time);
}

function detailUrl(id: string) {
  return '/pedidos/' + encodeURIComponent(id);
}

export function orderList(
  { rows, hasNext }: Awaited<ReturnType<typeof listPanelOrders>>, page: number, status?: OrderStatus,
) {
  const pageUrl = (next: number) => '/pedidos?' + new URLSearchParams({
    pagina: String(next), ...(status ? { estado: status } : {}),
  });
  return html`<!doctype html>${<Page title="Pedidos">
    <form class="card row" method="get" action="/pedidos">
      <label>Estado<select name="estado">
        <option value="" selected={!status}>Todos los estados</option>
        {orderStatuses.map((value) =>
          <option value={value} selected={value === status}>{statusLabels[value]}</option>)}
      </select></label>
      <button type="submit">Filtrar</button>
    </form>
    <div class="card scroll">
      {rows.length ? <table>
        <thead><tr><th>Pedido</th><th>Cliente</th><th>Estado</th><th>Subtotal</th><th>Fecha</th></tr></thead>
        <tbody>{rows.map((order) => <tr>
          <td><a href={detailUrl(order.id)}>#{order.number}</a></td><td>{order.buyerName ?? 'Datos anonimizados'}</td>
          <td>{statusLabels[order.status]}</td><td>{amount(order.subtotalAmount, order.currency)}</td>
          <td>{date(order.createdAt)}</td>
        </tr>)}</tbody>
      </table> : <p>No hay pedidos en esta página.</p>}
    </div>
    <nav class="pager" aria-label="Paginación de pedidos">
      {page > 1 && <a href={pageUrl(page - 1)}>Anterior</a>}
      <span>Página {page}</span>
      {hasNext && <a href={pageUrl(page + 1)}>Siguiente</a>}
    </nav>
  </Page>}`;
}

function ConflictAlert({ url, action, message, hidden }: {
  url: string; action: string; message?: string; hidden?: boolean;
}) {
  return <div role="alert" class="alert" hidden={hidden} data-payment-alert={hidden ? '' : undefined}>
    <p data-conflict-message="">{message}</p>
    <p>Acción conservada: <strong>{action}</strong>.</p>
    <a href={url}>Cargar la versión actual para continuar</a>
  </div>;
}

export function orderDetail(
  { order, items, history }: Awaited<ReturnType<typeof findPanelOrder>>,
  role: 'owner' | 'agent',
  conflict?: { message: string } & ({ draft: TransitionDraft } | { paymentStatus: 'paid' | 'refunded' }),
) {
  const available = allowedTransitions[order.status].filter(
    (status) => status !== 'cancelled' || role === 'owner',
  );
  const url = detailUrl(order.id);
  const stateConflict = conflict && 'draft' in conflict ? conflict : undefined;
  const paymentConflict = conflict && 'paymentStatus' in conflict ? conflict : undefined;
  const canMarkPaid = order.paymentStatus === 'unpaid' || order.paymentStatus === 'cod_pending';
  const canRefund = order.paymentStatus === 'paid' || order.paymentStatus === 'cod_collected';
  const paymentAction = paymentConflict?.paymentStatus
    ?? (canMarkPaid ? 'paid' : canRefund ? 'refunded' : null);
  const paymentActionLabel = paymentAction === 'paid' ? 'Marcar pagado' : 'Reembolsar';
  const owner = role === 'owner';
  return html`<!doctype html>${<Page title={'Pedido #' + order.number}>
    <a href="/pedidos">← Volver a pedidos</a>
    <section class="card">
      <h2>{statusLabels[order.status]}</h2>
      <p>{order.buyerName ?? 'Datos anonimizados'}{order.shipCity ? ' · ' + order.shipCity : ''}</p>
      <p>{paymentLabels[order.paymentStatus]} · Versión {order.version}</p>
      {paymentAction && <form class="row" action={url + '/pago'} method="post">
        <input type="hidden" name="expectedVersion" value={order.version} />
        <button type="submit" disabled={!owner || Boolean(paymentConflict)} title={owner ? undefined : 'Solo el propietario'}
          name="paymentStatus" value={paymentAction}
          class={paymentAction === 'refunded' ? 'danger' : undefined}
          data-payment-action={paymentAction} data-payment-version={order.version}
          data-payment-url={'/admin/orders/' + order.number + '/payment'}>{paymentActionLabel}</button>
        {paymentConflict && <ConflictAlert url={url} action={paymentActionLabel} message={paymentConflict.message} />}
        {owner && !paymentConflict && <>
          <ConflictAlert url={url} action={paymentActionLabel} hidden />
          <p role="alert" class="alert" data-payment-feedback="" hidden>No se pudo actualizar el pago.</p>
          <script>{raw(paymentScript)}</script>
        </>}
      </form>}
      <p>Subtotal <strong>{amount(order.subtotalAmount, order.currency)}</strong></p>
      <p>Total <strong>{amount(order.totalAmount, order.currency)}</strong></p>
    </section>
    <section class="card" aria-labelledby="estado-heading">
      <h2 id="estado-heading">Cambiar estado</h2>
      {stateConflict && <ConflictAlert url={url} action={actions[stateConflict.draft.status]} message={stateConflict.message} />}
      {stateConflict || available.length ? <form class="row" action={url} method="post">
        <input type="hidden" name="expectedVersion" value={stateConflict?.draft.expectedVersion ?? order.version} />
        {stateConflict
          ? <><input type="hidden" name="status" value={stateConflict.draft.status} />
            <button type="submit" disabled>{actions[stateConflict.draft.status]}</button></>
          : available.map((status) => <button type="submit" name="status" value={status}
            class={status === 'cancelled' ? 'danger' : undefined}>{actions[status]}</button>)}
      </form> : <p>No hay acciones disponibles para este estado.</p>}
    </section>
    <section class="card scroll"><h2>Ítems</h2>
      {items.length ? <table>
        <thead><tr><th>Producto</th><th>Presentación</th><th>Cantidad</th><th>Unitario</th><th>Importe</th></tr></thead>
        <tbody>{items.map((item) => <tr><td>{item.name}</td><td>{item.presentation}</td>
          <td>{item.qty}</td><td>{amount(item.unitAmount, order.currency)}</td>
          <td>{amount(item.lineAmount, order.currency)}</td></tr>)}</tbody>
      </table> : <p>Sin ítems registrados.</p>}
    </section>
    {order.anonymizedAt === null &&
      <OrderChat ticketUrl={'/api/pedidos/' + encodeURIComponent(order.id) + '/realtime-token'} />}
    <section class="card"><h2>Historial</h2>
      {history.length ? <ol>{history.map((event) => <li>
        <strong>{Object.hasOwn(events, event.type) ? events[event.type] : 'Evento registrado'}</strong>
        {event.to && <span> · {label(event.from)} → {label(event.to)}</span>}
        <br /><small>{date(event.at)}</small>
      </li>)}</ol> : <p>Sin eventos registrados.</p>}
    </section>
  </Page>}`;
}

function label(value: string | null) {
  const status = orderStatuses.find((candidate) => candidate === value);
  return status ? statusLabels[status] : 'Sin estado';
}
