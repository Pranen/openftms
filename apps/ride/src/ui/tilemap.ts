import type { World } from '../world/world';

const COLOURS = ['#e03030', '#f0a020', '#3070d0', '#8060c0', '#606060'];

/**
 * Debug map of the tile streaming (key K): every known tile per level, filled when ready,
 * outlined while loading, around the focus (±`range` m). Shows that tiles come and go even
 * where the view is seamless.
 */
export class TileMap {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private last = 0;
  visible = false;

  constructor(private readonly range = 20000) {
    const c = this.canvas;
    c.width = c.height = 240;
    c.className = 'tilemap';
    c.hidden = true;
    document.body.append(c);
    this.ctx = c.getContext('2d')!;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.canvas.hidden = !this.visible;
  }

  draw(world: World, now: number): void {
    if (!this.visible || now - this.last < 250) return;
    this.last = now;
    const f = world.focusLv95;
    if (!f) return;
    const { ctx } = this;
    const W = this.canvas.width;
    const s = W / (2 * this.range);
    const X = (e: number) => (e - f.e) * s + W / 2;
    const Y = (n: number) => (f.n - n) * s + W / 2;
    ctx.fillStyle = 'rgba(10,14,24,0.85)';
    ctx.fillRect(0, 0, W, W);
    const counts = [0, 0, 0, 0, 0].map(() => ({ ready: 0, loading: 0 }));
    const states = world.states().sort((a, b) => Number(b.key[0]) - Number(a.key[0]));
    for (const { key, state } of states) {
      const level = Number(key.split('/')[0]);
      const [ix, iy] = key.split('/')[1]!.split('_').map(Number) as [number, number];
      const size = world.manifest.levelInfo[String(level)]?.size ?? 0;
      const c = COLOURS[level] ?? '#fff';
      counts[level]![state]++;
      const x = X(ix * size);
      const y = Y((iy + 1) * size);
      const w = size * s;
      if (state === 'ready') {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, w, w);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = c;
      ctx.lineWidth = state === 'ready' ? 1 : 2;
      ctx.setLineDash(state === 'ready' ? [] : [3, 2]);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, w - 1);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(W / 2, W / 2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '8px "Press Start 2P", monospace';
    counts.forEach((c, l) => {
      ctx.fillStyle = COLOURS[l]!;
      ctx.fillText(`L${l} ${c.ready}${c.loading ? `+${c.loading}` : ''}`, 6, 12 + l * 11);
    });
    ctx.fillStyle = '#ccc';
    ctx.fillText(`${(world.bytes / 1e6).toFixed(1)} MB`, 6, W - 6);
  }
}
