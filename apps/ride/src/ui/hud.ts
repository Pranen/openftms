import type { Ride, TurnOption } from 'sim-core';

export interface HudData {
  mode: string;
  state: string;
  powerW: number;
  cadence: number | null;
  heartRate: number | null;
  ride: Ride;
  trainerGrade: number | null;
  paused: boolean;
}

const ARROW: Record<TurnOption['turn'], string> = { left: '◄', straight: '▲', right: '►', back: '▼' };

const $ = (id: string) => document.getElementById(id)!;

function clock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** DOM HUD at native resolution (numbers stay crisp over the 240 px picture). */
export class Hud {
  private readonly profile = $('profile') as HTMLCanvasElement;
  private readonly ctx = this.profile.getContext('2d')!;
  private lastProfile = 0;

  show(on: boolean): void {
    $('hud').hidden = !on;
  }

  toggle(): void {
    $('hud').hidden = !$('hud').hidden;
  }

  update(d: HudData, nowMs: number): void {
    const r = d.ride;
    $('pw').textContent = `${Math.round(d.powerW)} W`;
    $('cad').textContent = d.cadence !== null ? `${Math.round(d.cadence)} RPM` : '– RPM';
    $('hr').textContent = d.heartRate ? `${d.heartRate} ♥` : '';
    $('sp').textContent = (r.v * 3.6).toFixed(1);
    $('dist').textContent = `${(r.distance / 1000).toFixed(2)} KM`;
    $('time').textContent = clock(r.movingTime);
    const g = r.grade * 100;
    $('gr').textContent = `${g >= 0 ? '+' : ''}${g.toFixed(1)} %`;
    $('tgr').textContent = d.trainerGrade !== null ? `TRAINER ${d.trainerGrade >= 0 ? '+' : ''}${d.trainerGrade.toFixed(1)} %` : '';
    $('alt').textContent = `${Math.round(r.height)} M · ↑ ${Math.round(r.ascent)} M`;
    $('mode').textContent = `${d.mode} · ${d.state}`;
    $('name').textContent = r.graph.name(r.pos.edge).toUpperCase();
    $('pause').hidden = !d.paused;

    const up = r.upcoming;
    const turn = $('turn');
    if (up && up.distance < r.options.announceDistance && up.options.length > 1) {
      turn.hidden = false;
      turn.innerHTML =
        `<div class="lab">${Math.round(up.distance)} M</div>` +
        up.options
          .map((o, i) => `<span class="${i === up.selected ? 'sel' : ''}">${ARROW[o.turn]} ${(o.name || '').toUpperCase()}</span>`)
          .join('');
    } else {
      turn.hidden = true;
    }

    if (nowMs - this.lastProfile > 500) {
      this.lastProfile = nowMs;
      this.drawProfile(r);
    }
  }

  /** Height profile of the next 600 m along the planned path. */
  private drawProfile(r: Ride): void {
    const c = this.ctx;
    const w = this.profile.width;
    const h = this.profile.height;
    const n = 60;
    const hs: number[] = [];
    for (let k = 0; k <= n; k++) hs.push(r.heightAt(r.walk((600 * k) / n)));
    const lo = Math.min(...hs) - 2;
    const hi = Math.max(lo + 20, Math.max(...hs) + 2);
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#ff6a3d';
    for (let x = 0; x < w; x++) {
      const t = (x / (w - 1)) * n;
      const k = Math.min(n - 1, Math.floor(t));
      const v = hs[k]! + (hs[k + 1]! - hs[k]!) * (t - k);
      const y = Math.round(h - ((v - lo) / (hi - lo)) * (h - 2));
      c.fillRect(x, y, 1, h - y);
    }
    c.fillStyle = '#fff';
    c.fillRect(0, 0, 1, h);
  }
}
