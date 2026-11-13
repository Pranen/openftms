/** Typed `getElementById` that fails loudly if the markup and code drift apart. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

type Child = Node | string | number | null | undefined | false;

/** Tiny element factory: `h('span', { class: 'chip' }, 'text')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/**
 * Runs `fn` at most once per animation frame. Falls back to a timer when
 * frames are not delivered (background tab, embedded/headless views).
 */
export function rafThrottle(fn: () => void, fallbackMs = 100): () => void {
  let scheduled = false;
  const run = () => {
    if (!scheduled) return;
    scheduled = false;
    fn();
  };
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
    setTimeout(run, fallbackMs);
  };
}

export function timeOfDay(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
