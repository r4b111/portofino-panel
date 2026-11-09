export const widgetScript = `
(() => {
  const source = new URL(document.currentScript.src);
  if (customElements.get('pf-chat')) return;

  class PortofinoChat extends HTMLElement {
    static observedAttributes = ['token'];
    #button;
    #panel;

    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = \`<style>
        :host { display: block; color: #19362c; font: 1rem system-ui, sans-serif }
        button { color: white; background: #145741; border: 0; border-radius: .6rem;
          font: inherit; padding: .65rem 1rem; cursor: pointer }
        iframe { display: block; width: 100%; max-width: 30rem; height: 34rem;
          margin-top: .6rem; border: 1px solid #b8cfc5; border-radius: .75rem; background: white }
      </style>
      <button type="button" aria-expanded="false" aria-controls="pf-panel">Conversación del pedido</button>
      <div id="pf-panel" hidden></div>\`;
      this.#button = root.querySelector('button');
      this.#panel = root.querySelector('#pf-panel');
      this.#button.addEventListener('click', () => {
        this.#panel.hidden = !this.#panel.hidden;
        this.#button.setAttribute('aria-expanded', String(!this.#panel.hidden));
        if (!this.#panel.hidden && !this.#panel.firstChild) this.#load();
      });
    }

    attributeChangedCallback() {
      if (!this.#panel) return;
      this.#panel.replaceChildren();
      if (!this.#panel.hidden) this.#load();
    }

    #load() {
      const token = this.getAttribute('token') || '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        this.#panel.textContent = 'Código de seguimiento inválido.';
        return;
      }
      const url = new URL('/widgets/chat', source);
      url.hash = new URLSearchParams({ token });
      const frame = document.createElement('iframe');
      frame.title = 'Conversación del pedido Portofino';
      frame.referrerPolicy = 'no-referrer';
      frame.src = url.href;
      this.#panel.replaceChildren(frame);
    }
  }

  customElements.define('pf-chat', PortofinoChat);
})();
`;
