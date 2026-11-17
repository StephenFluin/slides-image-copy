/** A small status toast, isolated in a shadow root so page CSS can't touch it. */

type Kind = 'busy' | 'ok' | 'error';

let host: HTMLElement | null = null;
let box: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

const CSS = `
  .t {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    max-width: min(420px, calc(100vw - 32px));
    padding: 10px 14px; border-radius: 8px;
    font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #fff; background: #202124; box-shadow: 0 4px 16px rgb(0 0 0 / .3);
    opacity: 0; transform: translateY(8px); transition: opacity .15s, transform .15s;
    pointer-events: none;
  }
  .t.show { opacity: 1; transform: none; }
  .t.ok { background: #137333; }
  .t.error { background: #b3261e; }
`;

export function toast(message: string, kind: Kind): void {
  if (!host?.isConnected) {
    host = document.createElement('slides-image-copy-toast');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    box = document.createElement('div');
    box.setAttribute('role', 'status');
    root.append(style, box);
    (document.body ?? document.documentElement).append(host);
  }
  box!.textContent = message;
  box!.className = `t ${kind}`;
  requestAnimationFrame(() => box?.classList.add('show'));
  clearTimeout(timer);
  if (kind !== 'busy') {
    timer = setTimeout(() => box?.classList.remove('show'), kind === 'error' ? 5000 : 2500);
  }
}
