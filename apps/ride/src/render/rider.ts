import * as THREE from 'three/webgpu';
import { retroMaterial } from './retro';

/** Low-poly cyclist; the crank angle is integrated from the cadence, so the legs turn in the real rhythm. */
export class RiderModel {
  readonly group = new THREE.Group();
  private readonly legs: { thigh: THREE.Mesh; shin: THREE.Mesh; phase: number }[] = [];
  private crank = 0;

  constructor() {
    const mat = retroMaterial();
    const part = (geo: THREE.BufferGeometry, hex: number, x: number, y: number, z: number, rz = 0) => {
      const g = geo.toNonIndexed();
      const c = new THREE.Color(hex);
      const n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => [c.r, c.g, c.b][i % 3]!), 3));
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, y, z);
      m.rotation.z = rz;
      this.group.add(m);
      return m;
    };
    const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.05, 8);
    wheel.rotateX(Math.PI / 2);
    part(wheel, 0x1a1a1a, 0.52, 0.34, 0);
    part(wheel, 0x1a1a1a, -0.5, 0.34, 0);
    part(new THREE.BoxGeometry(1.0, 0.05, 0.05), 0xd02020, 0, 0.62, 0);
    part(new THREE.BoxGeometry(0.05, 0.4, 0.05), 0xd02020, -0.12, 0.5, 0);
    part(new THREE.BoxGeometry(0.62, 0.22, 0.34), 0xe03030, -0.05, 1.25, 0, -0.55);
    part(new THREE.BoxGeometry(0.2, 0.2, 0.2), 0xf0c8a0, 0.28, 1.47, 0);
    part(new THREE.BoxGeometry(0.22, 0.12, 0.24), 0xffffff, 0.27, 1.6, 0);
    part(new THREE.BoxGeometry(0.4, 0.07, 0.07), 0xe03030, 0.32, 1.17, 0.14, 0.9);
    part(new THREE.BoxGeometry(0.4, 0.07, 0.07), 0xe03030, 0.32, 1.17, -0.14, 0.9);
    for (const side of [1, -1]) {
      const thigh = part(new THREE.BoxGeometry(0.1, 0.46, 0.1), 0x202030, -0.25, 0.95, side * 0.11);
      const shin = part(new THREE.BoxGeometry(0.08, 0.46, 0.08), 0xf0c8a0, -0.1, 0.55, side * 0.11);
      this.legs.push({ thigh, shin, phase: side > 0 ? 0 : Math.PI });
    }
    this.group.scale.setScalar(1.1);
  }

  /** Place at (x, y, z) facing the tangent (tx, tz); advance the crank by the cadence. */
  update(x: number, y: number, z: number, tx: number, tz: number, cadenceRpm: number, dt: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = -Math.atan2(tz, tx);
    this.crank += (cadenceRpm / 60) * Math.PI * 2 * dt;
    const hip = new THREE.Vector2(-0.3, 1.12);
    for (const l of this.legs) {
      const a = this.crank + l.phase;
      const foot = new THREE.Vector2(-0.12 + Math.cos(a) * 0.17, 0.34 + Math.sin(a) * 0.17);
      const d = foot.clone().sub(hip);
      const len = Math.min(d.length(), 0.9);
      const knee = hip
        .clone()
        .add(d.clone().setLength(len / 2))
        .add(new THREE.Vector2(-d.y, d.x).setLength(Math.sqrt(Math.max(0, 0.45 ** 2 - (len / 2) ** 2))));
      const set = (o: THREE.Mesh, p: THREE.Vector2, q: THREE.Vector2) => {
        o.position.x = (p.x + q.x) / 2;
        o.position.y = (p.y + q.y) / 2;
        o.rotation.z = Math.atan2(q.y - p.y, q.x - p.x) - Math.PI / 2;
      };
      set(l.thigh, hip, knee);
      set(l.shin, knee, foot);
    }
  }
}
