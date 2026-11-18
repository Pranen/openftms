import * as THREE from 'three/webgpu';
import type { Ride } from 'sim-core';
import { CAMERA } from '../config';

/**
 * Chase camera that follows the road ahead (known from the graph), not the
 * rider's heading: no jumps at polyline kinks, curves announce themselves.
 */
export class ChaseCamera {
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private initialised = false;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  update(ride: Ride, dt: number): void {
    const here = ride.pointAhead(0);
    const ahead = ride.pointAhead(10);
    let dx = ahead.x - here.x;
    let dz = ahead.z - here.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const target = ride.pointAhead(CAMERA.lookAhead);
    const desired = new THREE.Vector3(here.x - dx * CAMERA.behind, here.h + CAMERA.height, here.z - dz * CAMERA.behind);
    const lookAt = new THREE.Vector3(target.x, target.h + CAMERA.lookHeight, target.z);
    const k = this.initialised ? 1 - Math.exp(-dt * CAMERA.smoothing) : 1;
    this.pos.lerp(desired, k);
    this.look.lerp(lookAt, k);
    this.initialised = true;
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  reset(): void {
    this.initialised = false;
  }
}

/**
 * Free flight for checking the graphics ("Demo: Fliegen"): WASD / arrows move,
 * Q/E down/up, Shift fast, mouse drag looks around, wheel changes the speed.
 */
export class FlyCamera {
  yaw = 0;
  pitch = -0.25;
  speed = 25;
  private readonly keys = new Set<string>();
  private dragging = false;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.type === 'keydown') this.keys.add(e.code);
    else this.keys.delete(e.code);
  };
  private readonly onDown = (e: PointerEvent) => {
    this.dragging = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  private readonly onUp = () => (this.dragging = false);
  private readonly onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.yaw -= e.movementX * 0.004;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.004));
  };
  private readonly onWheel = (e: WheelEvent) => {
    this.speed = Math.max(3, Math.min(400, this.speed * (e.deltaY > 0 ? 0.85 : 1.18)));
  };

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly element: HTMLElement,
    private readonly ground: (x: number, z: number) => number | null,
  ) {}

  enable(from: THREE.Vector3, yaw: number): void {
    this.camera.position.copy(from);
    this.yaw = yaw;
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKey);
    this.element.addEventListener('pointerdown', this.onDown);
    addEventListener('pointerup', this.onUp);
    addEventListener('pointermove', this.onMove);
    this.element.addEventListener('wheel', this.onWheel, { passive: true });
  }

  disable(): void {
    removeEventListener('keydown', this.onKey);
    removeEventListener('keyup', this.onKey);
    this.element.removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('pointermove', this.onMove);
    this.element.removeEventListener('wheel', this.onWheel);
    this.keys.clear();
  }

  update(dt: number): void {
    const k = this.keys;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const u = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0);
    const dir = new THREE.Vector3(Math.cos(this.pitch) * Math.cos(this.yaw), Math.sin(this.pitch), -Math.cos(this.pitch) * Math.sin(this.yaw));
    const right = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const p = this.camera.position;
    const v = this.speed * fast * dt;
    p.addScaledVector(dir, f * v).addScaledVector(right, r * v);
    p.y += u * v;
    const g = this.ground(p.x, p.z);
    if (g !== null && p.y < g + 1.5) p.y = g + 1.5;
    this.camera.lookAt(p.clone().add(dir));
  }
}
