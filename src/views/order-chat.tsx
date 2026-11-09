import { html, raw } from 'hono/html';

const chatScript = String.raw`
(() => {
  const root = document.querySelector('[data-order-chat]');
  if (!root) return;
  const feed = root.querySelector('[data-messages]');
  const indicator = root.querySelector('[data-connection]');
  const state = root.querySelector('[data-live-status]');
  const form = root.querySelector('[data-message-form]');
  const input = form.elements.body;
  const submit = form.querySelector('button');
  const access = root.querySelector('[data-tracking-form]');
  const labels = {
    pending_confirmation: 'Pendiente de confirmación', confirmed: 'Confirmado',
    packing: 'En preparación', shipped: 'Enviado', delivered: 'Entregado',
    cancelled: 'Cancelado', returned: 'Devuelto', expired: 'Vencido'
  };
  let socket, timer, renewal, customerDraft;
  let generation = 0;
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

  function connect(current) {
    if (current !== generation) return;
    submit.disabled = true;
    indicator.textContent = 'Conectando…';
    const headers = trackingToken ? { 'X-Tracking-Token': trackingToken } : {};
    const retry = () => {
      if (current !== generation) return;
      submit.disabled = true;
      indicator.textContent = 'Reconectando…';
      timer = setTimeout(() => connect(current), 1500);
    };
    fetch(root.dataset.ticketUrl, { method: 'POST', headers }).then(async (response) => {
      if (current !== generation) return;
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
            }
            break;
          case 'ready':
            indicator.textContent = 'En línea';
            submit.disabled = false;
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!socket || socket.readyState !== WebSocket.OPEN || submit.disabled || !body) return;
    if (access) {
      const current = generation;
      const original = input.value;
      if (customerDraft?.body !== body) customerDraft = { id: crypto.randomUUID(), body };
      submit.disabled = true;
      try {
        const response = await fetch('/api/orders/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tracking-Token': trackingToken },
          body: JSON.stringify(customerDraft)
        });
        if (current !== generation) return;
        if (response.status === 429) {
          indicator.textContent = 'Límite de mensajes alcanzado. Intenta en ' + response.headers.get('Retry-After') + ' s.';
        } else if (response.ok) {
          if (input.value === original) input.value = '';
          customerDraft = undefined;
          indicator.textContent = 'En línea';
        } else {
          indicator.textContent = 'No se pudo enviar el mensaje.';
        }
      } catch {
        if (current === generation) indicator.textContent = 'Se interrumpió la conexión. Intenta de nuevo.';
      } finally {
        if (current === generation) submit.disabled = socket?.readyState !== WebSocket.OPEN;
      }
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
    cursor = 0;
    version = 0;
    pending.clear();
    customerDraft = undefined;
    feed.replaceChildren();
    state.textContent = 'Por consultar';
    connect(generation);
  }

  if (access) {
    const savedLink = new URLSearchParams(location.hash.slice(1)).get('token');
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
    clearTimeout(timer);
    clearTimeout(renewal);
    if (socket) socket.close();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && (!access || trackingToken)) connect(++generation);
  });
})();
`;

export function OrderChat({ ticketUrl, customer = false }: { ticketUrl: string; customer?: boolean }) {
  return <section class="card" data-order-chat="" data-ticket-url={ticketUrl} aria-labelledby="chat-title">
    <h2 id="chat-title">Conversación del pedido</h2>
    {customer && <form method="post" data-tracking-form="">
      <label>Código de seguimiento <input name="tracking" type="password" required
        autocomplete="off" maxlength={43} /></label>
      <button type="submit">Abrir conversación</button>
    </form>}
    <p>Estado en vivo <strong data-live-status="">Por consultar</strong></p>
    <p role="status" data-connection="">{customer ? 'Ingresa tu código para consultar el pedido.' : 'Conectando…'}</p>
    <ol data-messages="" aria-live="polite" aria-label="Mensajes"></ol>
    <form method="post" data-message-form="">
      <label>Mensaje <input name="body" maxlength={2000} required autocomplete="off" /></label>
      <button type="submit" disabled>Enviar</button>
    </form>
    <script>{raw(chatScript)}</script>
  </section>;
}

export function trackingPage() {
  return html`<!doctype html>${<html lang="es">
    <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" /><title>Seguimiento | Portofino</title></head>
    <body><main><h1>Seguimiento de pedido</h1>
      <OrderChat ticketUrl="/api/orders/realtime-token" customer />
    </main></body>
  </html>}`;
}
