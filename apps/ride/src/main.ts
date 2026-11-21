import '@fontsource/press-start-2p';
import * as THREE from 'three/webgpu';
import { FixedStepClock, GradeController, Recorder, Ride, airDensity, crrForSurface, DEFAULT_RIDER } from 'sim-core';
import { RENDER, RIDER, ROUNDABOUT, SIM, STREAM, TRAINER } from './config';
import { AutopilotSource, TrainerSource, type PowerSource } from './devices/power-source';
import { ChaseCamera, FlyCamera } from './render/cameras';
import { RetroRenderer } from './render/retro';
import { RiderModel } from './render/rider';
import { Trees } from './render/trees';
import { buildRoads, createScenes, disposeGroup, nodeHeight, roadHeight, roadLift, tileView, type TileView } from './render/scene';
import { Hud } from './ui/hud';
import { TileMap } from './ui/tilemap';
import { chunkChild } from './world/select';
import { World } from './world/world';
import type { TileMesh } from './workers/world-worker';

type Mode = 'trainer' | 'simulator' | 'autopilot' | 'fly';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const { near: scene, far: farScene } = createScenes();
const camera = new THREE.PerspectiveCamera(RENDER.fovDeg, innerWidth / innerHeight, RENDER.near, RENDER.far);
const retro = new RetroRenderer(canvas);
const hud = new Hud();
const riderModel = new RiderModel();
const chase = new ChaseCamera(camera);
let world: World;
let fly: FlyCamera;
let trees: Trees;
let roads = new Map<string, THREE.Group>();
const views = new Map<string, { view: TileView; level: number; ix: number; iy: number; chunks: number }>();
const tileMap = new TileMap();
/** The ride behind the menu (rider standing at the spawn). */
let attract: Ride | null = null;
/** The ridden line uses the roundabout ring as drawn. */
const LINE = { ringLane: ROUNDABOUT.lane, ringMinIsland: ROUNDABOUT.minIsland };

interface Session {
  mode: Mode;
  source: PowerSource | null;
  ride: Ride;
  clock: FixedStepClock;
  grade: GradeController;
  recorder: Recorder;
  flying: boolean;
  paused: boolean;
  stillSince: number | null;
  lastSurface: number;
  fallback: number;
  wakeLock: WakeLockSentinel | null;
}
let session: Session | null = null;

// --- boot ------------------------------------------------------------------------------

async function boot(): Promise<void> {
  await retro.init(scene, farScene, camera);
  resize();
  addEventListener('resize', resize);
  world = await World.load(`${import.meta.env.BASE_URL}world/`, { ready: onTileReady, dropped: onTileDropped });
  trees = new Trees();
  scene.add(trees.group);
  roads = buildRoads(world.graph, world.manifest.origin, world.manifest.levelInfo['0']?.size ?? 2000);
  scene.add(riderModel.group);
  // first the tiles around the spawn, then the menu
  const sp = world.toWorld(...world.manifest.spawn);
  world.update(sp.x, sp.z);
  while (!world.settled || arrivals.length) {
    addArrivals(50);
    const s = world.states();
    $('loading').textContent = `LADE WELT … ${s.filter((t) => t.state === 'ready').length}/${s.length} KACHELN`;
    await new Promise((r) => setTimeout(r, 100));
  }
  fly = new FlyCamera(camera, canvas, (x, z) => world.terrainHeight(x, z));
  $('loading').textContent = `${world.graph.edgeCount} STRASSENABSCHNITTE · ${(totalLength() / 1000).toFixed(0)} KM · ${trees.count} BÄUME (NAH) · ${retro.backendName}`;
  $('attribution').textContent = world.manifest.attribution.join(' · ');
  for (const id of ['btn-trainer', 'btn-sim', 'btn-auto', 'btn-fly']) ($(id) as HTMLButtonElement).disabled = false;
  $('btn-trainer').onclick = () => start('trainer');
  $('btn-sim').onclick = () => start('simulator');
  $('btn-auto').onclick = () => start('autopilot');
  $('btn-fly').onclick = () => start('fly');
  addEventListener('keydown', onKey);
  // attract view behind the menu
  const spawn = spawnPos();
  attract = new Ride(world.graph, spawn, { line: LINE });
  chase.update(attract, 1);
  updateRider(attract, 0, 0);
  requestAnimationFrame(frame);
  if (import.meta.env.DEV) (window as unknown as { __ride: unknown }).__ride = { world, scene, camera, get session() { return session; }, retro, get trees() { return trees; }, views, get fly() { return fly; } };
}

// --- tile streaming --------------------------------------------------------------------

/** Arrived tiles wait here and enter the scene a few per frame (no stall when several arrive at once). */
const arrivals: [TileMesh, string][] = [];

function onTileReady(t: TileMesh, key: string): void {
  arrivals.push([t, key]);
}

function addArrivals(budgetMs: number): void {
  const t0 = performance.now();
  let changed = false;
  while (arrivals.length && performance.now() - t0 < budgetMs) {
    const [t, key] = arrivals.shift()!;
    addTileView(t, key);
    changed = true;
  }
  if (changed) refreshChunks();
}

function addTileView(t: TileMesh, key: string): void {
  const view = tileView(t);
  views.set(key, { view, level: t.level, ix: t.ix, iy: t.iy, chunks: t.chunks });
  (t.level < STREAM.nearLevels ? scene : farScene).add(view.group);
  if (t.level === 0) {
    trees.add(t, key);
    const r = roads.get(key);
    if (r) scene.add(r);
  }
}

function onTileDropped(t: TileMesh, key: string): void {
  const i = arrivals.findIndex(([, k]) => k === key);
  if (i >= 0) arrivals.splice(i, 1);
  const v = views.get(key);
  if (v) disposeGroup(v.view.group);
  views.delete(key);
  if (t.level === 0) {
    trees.remove(key);
    roads.get(key)?.removeFromParent();
  }
  refreshChunks();
}

/** A coarse chunk is hidden where the finer tile covering it is loaded (no overlapping levels). */
function refreshChunks(): void {
  for (const v of views.values()) {
    if (v.level === 0) continue;
    v.view.chunks.forEach((m, k) => {
      m.visible = !views.has(chunkChild(v.level, v.ix, v.iy, k % v.chunks, Math.floor(k / v.chunks), v.chunks));
    });
  }
}

function totalLength(): number {
  let L = 0;
  for (let e = 0; e < world.graph.edgeCount; e++) L += world.graph.length(e);
  return L;
}

function spawnPos() {
  const [e, n] = world.manifest.spawn;
  const p = world.toWorld(e, n);
  const near = world.graph.nearest(p.x, p.z, 500) ?? { edge: 0, s: 0, dist: 0 };
  return { edge: near.edge, dir: 1 as const, s: near.s };
}

function resize(): void {
  retro.resize(innerWidth, innerHeight, camera);
}

// --- sessions --------------------------------------------------------------------------

async function start(mode: Mode): Promise<void> {
  $('error').textContent = '';
  let source: PowerSource | null = null;
  try {
    if (mode === 'trainer' || mode === 'simulator') {
      const t = new TrainerSource(mode === 'trainer' ? 'bluetooth' : 'simulator');
      $('loading').textContent = mode === 'trainer' ? 'VERBINDE TRAINER … (5–8 S)' : 'STARTE SIMULATOR …';
      await t.connect(); // inside the click: opens the Bluetooth chooser
      source = t;
    } else if (mode === 'autopilot') {
      source = new AutopilotSource();
    }
  } catch (err) {
    $('error').textContent = `VERBINDUNG FEHLGESCHLAGEN: ${(err as Error).message}`;
    $('loading').textContent = '';
    return;
  }
  stop();
  const ride = new Ride(world.graph, spawnPos(), { rider: DEFAULT_RIDER, line: LINE });
  session = {
    mode,
    source,
    ride,
    clock: new FixedStepClock(SIM.step),
    grade: new GradeController(TRAINER),
    recorder: new Recorder(),
    flying: mode === 'fly',
    paused: false,
    stillSince: null,
    lastSurface: -1,
    fallback: window.setInterval(() => tick(performance.now()), SIM.fallbackIntervalMs),
    wakeLock: null,
  };
  source?.onTelemetry(() => tick(performance.now()));
  chase.reset();
  if (session.flying) startFlying();
  $('menu').hidden = true;
  hud.show(mode !== 'fly');
  try {
    session.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not available: fine */
  }
}

function stop(): void {
  if (!session) return;
  clearInterval(session.fallback);
  session.source?.dispose();
  session.wakeLock?.release().catch(() => undefined);
  fly?.disable();
  session = null;
}

function startFlying(): void {
  const p = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  fly.enable(p, Math.atan2(-dir.z, dir.x));
}

function toMenu(): void {
  stop();
  hud.show(false);
  $('menu').hidden = false;
  $('loading').textContent = '';
}

function onKey(e: KeyboardEvent): void {
  if (e.code === 'Escape') return toMenu();
  const s = session;
  if (!s) return;
  if (e.code === 'KeyV') retro.toggleSnap();
  if (e.code === 'KeyB') retro.toggleDither();
  if (e.code === 'KeyH') hud.toggle();
  if (e.code === 'KeyK') tileMap.toggle();
  if (s.mode === 'fly') return;
  if (e.code === 'KeyF') {
    s.flying = !s.flying;
    if (s.flying) startFlying();
    else {
      fly.disable();
      chase.reset();
    }
    return;
  }
  if (s.flying) return; // arrows belong to the fly camera
  if (e.code === 'ArrowLeft') s.ride.choose('left') || s.ride.cycle(-1);
  if (e.code === 'ArrowRight') s.ride.choose('right') || s.ride.cycle(1);
  if (e.code === 'ArrowUp') s.ride.choose('straight');
  if (e.code === 'ArrowDown') s.ride.choose('back');
  if (e.key === '+' || e.code === 'NumpadAdd') s.source?.adjust(1);
  if (e.key === '-' || e.code === 'NumpadSubtract') s.source?.adjust(-1);
  if (e.code === 'KeyP') {
    s.paused = !s.paused;
    s.clock.hold();
  }
}

// --- simulation ------------------------------------------------------------------------

/** Advance the simulation to now. Called by animation frames, telemetry and a fallback interval. */
function tick(now: number): void {
  const s = session;
  if (!s || !s.source || s.paused) return;
  const src = s.source;
  s.clock.advanceTo(now, (dt, t) => {
    const power = src.power(now);
    s.ride.step(dt, power);
    const p = s.ride.pointAhead(0);
    s.recorder.offer({ t, x: p.x, z: p.z, h: p.h, v: s.ride.v, distance: s.ride.distance, powerW: power, cadenceRpm: src.cadence(), heartRateBpm: src.heartRate() });
  });
  // trainer: grade ahead (latency compensated), scaled and rate limited
  const r = s.ride;
  const g = r.gradeAhead(r.v * SIM.gradeLatencyS, SIM.gradeWindowM);
  const send = s.grade.update(s.clock.time, g);
  if (send !== null) src.setGrade(send);
  const surf = r.graph.surface(r.pos.edge);
  if (surf !== s.lastSurface) {
    s.lastSurface = surf;
    src.setResistance(crrForSurface(surf), 0.5 * airDensity(r.height) * DEFAULT_RIDER.cda);
  }
}

/** Pose the rider from the ridden line: position, heading, grade and the curvature for the lean. */
function updateRider(r: Ride, cadence: number, dt: number): void {
  const p = r.lineAt(0);
  const grade = (r.lineAt(1.5).h - r.lineAt(-1.5).h) / 3;
  const kAhead = r.lineAt(r.v * RIDER.leanLeadS).k;
  riderModel.update({ x: p.x, y: surfaceY(r, p.x, p.z, p.h), z: p.z, tx: p.tx, tz: p.tz, grade, k: p.k, kAhead, v: r.v, cadence, dt });
}

/**
 * Height of the drawn surface under the rider: the road band (lifted per class, as in buildRoads)
 * or the roundabout ring, which lies above its approaches.
 */
function surfaceY(r: Ride, x: number, z: number, h: number): number {
  const g = r.graph;
  let y = Math.max(h, roadHeight(g, r.pos.edge, r.pos.s)) + roadLift(g.edgeClass(r.pos.edge));
  for (const [n, radius] of g.meta.roundabouts ?? []) {
    const ri = Math.max(ROUNDABOUT.minIsland, radius - ROUNDABOUT.lane / 2);
    if (Math.hypot(x - g.nodeX(n), z - g.nodeZ(n)) < ri + ROUNDABOUT.lane + 0.5) y = Math.max(y, nodeHeight(g, n) + RENDER.roadLift + ROUNDABOUT.lift);
  }
  return y + RIDER.clearance;
}

let lastFrame = performance.now();
let lastStream = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const s = session;
  if (s) {
    tick(now);
    const r = s.ride;
    updateRider(r, s.paused ? 0 : (s.source?.cadence() ?? 0), s.paused ? 0 : dt);
    riderModel.group.visible = s.mode !== 'fly';
    if (s.flying) fly.update(dt);
    else chase.update(r, dt);
    if (s.source) {
      const still = s.source.power(now) === 0 && r.v * 3.6 < SIM.autoPauseKmh;
      s.stillSince = still ? (s.stillSince ?? now) : null;
      hud.update(
        {
          mode: s.source.label,
          state: s.source.state(),
          powerW: s.source.power(now),
          cadence: s.source.cadence(),
          heartRate: s.source.heartRate(),
          ride: r,
          trainerGrade: s.mode === 'autopilot' ? null : s.grade.sent,
          paused: s.paused || (s.stillSince !== null && now - s.stillSince > SIM.autoPauseS * 1000),
        },
        now,
      );
    }
  } else if (attract) {
    updateRider(attract, 0, dt);
    riderModel.group.visible = true;
  }
  const sky = farScene.getObjectByName('sky');
  sky?.position.copy(camera.position);
  trees?.update(camera.position);
  if (world && now - lastStream > STREAM.intervalMs) {
    lastStream = now;
    world.update(camera.position.x, camera.position.z);
  }
  if (world) {
    addArrivals(6);
    tileMap.draw(world, now);
  }
  retro.render();
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  $('error').textContent = `FEHLER: ${(err as Error).message}`;
});
