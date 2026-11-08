import { html, raw } from 'hono/html';

const chatScript = String.raw`
(() => {
  const root = document.querySelector('[data-order-chat]');
  if (!root) return;
  const feed = root.querySelector('[data-messages]');
  const indicator = root.querySelector('[data-connection]');
  const notice = root.querySelector('[data-chat-notice]');
  const embedded = root.hasAttribute('data-embedded-chat');
  const state = root.querySelector('[data-live-status]');
  const form = root.querySelector('[data-message-form]');
  const input = form.elements.body;
  const submit = form.querySelector('button');
  const access = root.querySelector('[data-tracking-form]');
  const customerChat = embedded || Boolean(access);
  const breakdown = root.querySelector('[data-shipping-breakdown]');
  const labels = {
    pending_confirmation: 'Pendiente de confirmación', confirmed: 'Confirmado',
    packing: 'En preparación', shipped: 'Enviado', delivered: 'Entregado',
    cancelled: 'Cancelado', returned: 'Devuelto', expired: 'Vencido'
  };
  let socket, timer, renewal, customerDraft;
  let generation = 0;
  let reconnectDelay = 1000;
  let sending = false;
  let cursor = 0;
  let version = 0;
  let trackingToken = '';
  const pending = new Map();

  function append(message) {
    if (message.seq > cursor) {
      const item = document.createElement('li');
      item.textContent = (message.role === 'agent' ? 'Equipo de Portofino' : 'Cliente') + ': ' + message.body;
      feed.append(item);
      cursor = message.seq;
    }
    pending.delete(message.id);
  }

  async function showShipping(current, orderVersion) {
    try {
      const response = await fetch('/orders/tracking', { headers: { 'X-Tracking-Token': trackingToken } });
      if (!response.ok) return;
      const { order } = await response.json();
      if (current !== generation || orderVersion !== version) return;
      const money = new Intl.NumberFormat('es-CO', {
        style: 'currency', currency: order.currency, maximumFractionDigits: 0,
      });
      const quote = order.shippingCost !== null && order.totalAmount !== null;
      const fields = {
        subtotal: money.format(order.subtotalAmount),
        cost: quote ? money.format(order.shippingCost) : 'Por confirmar',
        total: quote ? money.format(order.totalAmount) : 'Por confirmar',
        carrier: order.carrier ?? 'Por confirmar',
        eta: order.shippingEtaDays === null ? 'Por confirmar'
          : order.shippingEtaDays === 0 ? 'El mismo día'
          : order.shippingEtaDays + (order.shippingEtaDays === 1 ? ' día' : ' días'),
      };
      for (const [name, value] of Object.entries(fields)) {
        breakdown.querySelector('[data-quote="' + name + '"]').textContent = value;
      }
      breakdown.hidden = false;
    } catch {
      // The next status update or reconnect will retry.
    }
  }

  function connect(current) {
    if (current !== generation) return;
    submit.disabled = true;
    indicator.textContent = 'Conectando…';
    const headers = trackingToken ? { 'X-Tracking-Token': trackingToken } : {};
    const retry = () => {
      if (current !== generation) return;
      submit.disabled = true;
      indicator.textContent = 'Reconectando…';
      timer = setTimeout(() => connect(current), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
    fetch(root.dataset.ticketUrl, { method: 'POST', headers }).then(async (response) => {
      if (current !== generation) return;
      if (response.status === 410) {
        indicator.textContent = 'El enlace caducó';
        return;
      }
      if (response.redirected || [400, 401, 403, 404].includes(response.status)) {
        indicator.textContent = 'Acceso al pedido no disponible. Verifica tu sesión o código.';
        return;
      }
      if (!response.ok) return retry();
      const ticket = await response.json();
      if (current !== generation) return;
      const url = new URL('/api/orders/' + encodeURIComponent(ticket.orderId) + '/realtime', location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('after', String(cursor));
      const connected = new WebSocket(url, ['portofino.v1', 'ticket.' + ticket.token]);
      socket = connected;
      renewal = setTimeout(() => connected.close(), Math.max(0, ticket.expiresAt - Date.now()));
      connected.addEventListener('message', (event) => {
        if (current !== generation) return;
        const frame = JSON.parse(event.data);
        switch (frame.type) {
          case 'history': frame.messages.forEach(append); break;
          case 'message': append(frame.message); break;
          case 'ack': pending.delete(frame.id); break;
          case 'status':
            if (frame.version >= version) {
              version = frame.version;
              state.textContent = labels[frame.status] || 'Estado actualizado';
              if (breakdown) void showShipping(current, frame.version);
            }
            break;
          case 'ready':
            indicator.textContent = 'En línea';
            reconnectDelay = 1000;
            submit.disabled = sending;
            pending.forEach((message) => connected.send(message));
            break;
          case 'error': indicator.textContent = frame.message; break;
        }
      });
      connected.addEventListener('close', () => {
        if (current !== generation) return;
        clearTimeout(renewal);
        retry();
      });
    }).catch(retry);
  }

  async function sendCustomerMessage(body) {
    const current = generation;
    const original = input.value;
    if (customerDraft?.body !== body) customerDraft = { id: crypto.randomUUID(), body };
    sending = true;
    submit.disabled = true;
    try {
      const response = await fetch('/api/orders/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tracking-Token': trackingToken },
        body: JSON.stringify(customerDraft)
      });
      if (current !== generation) return;
      if (response.status === 429) {
        notice.textContent = 'Límite de mensajes alcanzado. Intenta en ' + response.headers.get('Retry-After') + ' s.';
      } else if (response.ok) {
        if (input.value === original) input.value = '';
        customerDraft = undefined;
        notice.textContent = '';
      } else {
        indicator.textContent = 'No se pudo enviar el mensaje.';
      }
    } catch {
      if (current === generation) indicator.textContent = 'Se interrumpió la conexión. Intenta de nuevo.';
    } finally {
      if (current === generation) {
        sending = false;
        submit.disabled = socket?.readyState !== WebSocket.OPEN;
      }
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!socket || socket.readyState !== WebSocket.OPEN || submit.disabled || sending || !body) return;
    if (customerChat) {
      void sendCustomerMessage(body);
      return;
    }
    const id = crypto.randomUUID();
    const message = JSON.stringify({ type: 'message', id, body });
    pending.set(id, message);
    socket.send(message);
    input.value = '';
  });

  function start(token) {
    generation++;
    clearTimeout(timer);
    clearTimeout(renewal);
    if (socket) socket.close();
    trackingToken = token;
    reconnectDelay = 1000;
    sending = false;
    notice.textContent = '';
    cursor = 0;
    version = 0;
    pending.clear();
    customerDraft = undefined;
    feed.replaceChildren();
    state.textContent = 'Por consultar';
    if (breakdown) breakdown.hidden = true;
    connect(generation);
  }

  const savedLink = new URLSearchParams(location.hash.slice(1)).get('token');
  if (embedded) {
    if (savedLink && /^[A-Za-z0-9_-]{43}$/.test(savedLink)) start(savedLink);
    else indicator.textContent = 'Código de seguimiento inválido.';
  } else if (access) {
    access.addEventListener('submit', (event) => {
      event.preventDefault();
      const token = access.elements.tracking.value.trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        indicator.textContent = 'Código de seguimiento inválido.';
        return;
      }
      start(token);
    });
    if (savedLink && /^[A-Za-z0-9_-]{43}$/.test(savedLink)) {
      access.elements.tracking.value = savedLink;
      start(savedLink);
    }
  } else {
    start('');
  }

  window.addEventListener('pagehide', () => {
    generation++;
    sending = false;
    clearTimeout(timer);
    clearTimeout(renewal);
    if (socket) socket.close();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && (!customerChat || trackingToken)) connect(++generation);
  });
})();
`;

export function OrderChat({ ticketUrl, customer = false, embedded = false }: {
  ticketUrl: string; customer?: boolean; embedded?: boolean;
}) {
  return <section class="card" data-order-chat="" data-ticket-url={ticketUrl}
    data-embedded-chat={embedded ? '' : undefined} aria-labelledby="chat-title">
    <h2 id="chat-title">Conversación del pedido</h2>
    {customer && <form method="post" data-tracking-form="">
      <label>Código de seguimiento <input name="tracking" type="password" required
        autocomplete="off" maxlength={43} /></label>
      <button type="submit">Abrir conversación</button>
    </form>}
    <p>Estado en vivo <strong data-live-status="">Por consultar</strong></p>
    {embedded && <section data-shipping-breakdown="" aria-label="Desglose del pedido" aria-live="polite" hidden>
      <dl>
        <dt>Subtotal</dt><dd data-quote="subtotal"></dd>
        <dt>Envío</dt><dd data-quote="cost"></dd>
        <dt>Total</dt><dd data-quote="total"></dd>
        <dt>Transportadora</dt><dd data-quote="carrier"></dd>
        <dt>Entrega estimada</dt><dd data-quote="eta"></dd>
      </dl>
    </section>}
    <p role="status" data-connection="">{customer ? 'Ingresa tu código para consultar el pedido.' : 'Conectando…'}</p>
    <ol data-messages="" aria-live="polite" aria-label="Mensajes"></ol>
    <p role="status" data-chat-notice=""></p>
    <form method="post" data-message-form="">
      <label>Mensaje <input name="body" maxlength={2000} required autocomplete="off" /></label>
      <button type="submit" disabled>Enviar</button>
    </form>
    <script>{raw(chatScript)}</script>
  </section>;
}

const embeddedStyle = `
  body { margin: 0; padding: 1rem; color: #19362c; background: #fff; font: 1rem system-ui, sans-serif; }
  h2 { margin: 0; font-size: 1.2rem; }
  ol { max-height: 18rem; overflow: auto; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .35rem .6rem;
    background: #f2f7f4; padding: .75rem; border-radius: .5rem; }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  input { box-sizing: border-box; display: block; width: 100%; padding: .45rem; font: inherit; }
  button { margin-top: .6rem; padding: .5rem .8rem; color: white; background: #145741;
    border: 0; border-radius: .5rem; font: inherit; }
  button:disabled { opacity: .6; }
  [data-chat-notice]:not(:empty) { background: #fff4d5; color: #624700; padding: .6rem; border-radius: .5rem; }
`;

export function trackingPage(embedded = false) {
  return html`<!doctype html>${<html lang="es">
    <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" /><title>Seguimiento | Portofino</title>
      {embedded && <style>{raw(embeddedStyle)}</style>}</head>
    <body><main>{!embedded && <h1>Seguimiento de pedido</h1>}
      <OrderChat ticketUrl="/api/orders/realtime-token" customer={!embedded} embedded={embedded} />
    </main></body>
  </html>}`;
}
