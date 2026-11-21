import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RIDER } from '../config';
import { retroMaterial } from './retro';

/** What the rider model needs per frame (from the ride and the power source). */
export interface RiderInput {
  /** Position on the ridden line (ground) and unit tangent. */
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  /** Grade along the line (fraction). */
  grade: number;
  /** Curvature here and a little ahead (1/m, + right). */
  k: number;
  kAhead: number;
  /** Speed (m/s), cadence (rpm, 0 = not pedalling). */
  v: number;
  cadence: number;
  dt: number;
}

// --- geometry helpers (model space: x forward, y up, z right; metres) ----------------------

const Y = new THREE.Vector3(0, 1, 0);
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Non-indexed, with a flat vertex colour (the retro material shades flat by vertex colour). */
function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Cylinder between a and b. */
function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, hex: number, sides = 5, r2 = r): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r2, r, len, sides);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, d.normalize()));
  g.translate(a.x, a.y, a.z);
  return paint(g, hex);
}

/** Polyline of tubes. */
function tubes(pts: THREE.Vector3[], r: number, hex: number): THREE.BufferGeometry[] {
  return pts.slice(1).map((p, i) => tube(pts[i]!, p, r, hex));
}

/** Box along +y from y0 to y1, depth (x) and width (z) tapering linearly. */
function taper(y0: number, y1: number, d0: number, d1: number, w0: number, w1: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) + 0.5;
    p.setXYZ(i, p.getX(i) * (d0 + (d1 - d0) * t), y0 + (y1 - y0) * t, p.getZ(i) * (w0 + (w1 - w0) * t));
  }
  g.computeVertexNormals();
  return paint(g, hex);
}

function box(w: number, h: number, d: number, hex: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return paint(g, hex);
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const p of parts) if (!p.getAttribute('normal')) p.computeVertexNormals();
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

/** Two-bone IK: the middle joint for root a, target t, bone lengths l1, l2, bending towards pole. */
function ik(a: THREE.Vector3, t: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out: THREE.Vector3): void {
  const dir = t.clone().sub(a);
  let d = dir.length();
  dir.divideScalar(d || 1);
  d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-3, d));
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const p = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  out.copy(a).addScaledVector(dir, x).addScaledVector(p, h);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// --- dimensions (a 1.78 m rider on a 56 cm road bike) ----------------------------------------

const WHEEL_R = 0.335;
const REAR = v3(-0.49, WHEEL_R, 0);
const FRONT = v3(0.5, WHEEL_R, 0);
const BB = v3(-0.08, 0.27, 0);
const CRANK = 0.1725;
const SEAT = v3(-0.22, 0.77, 0);
const HEAD_TOP = v3(0.296, 0.853, 0);
const HEAD_BOTTOM = v3(0.34, 0.709, 0);
/** Steering axis (73°) through the head tube; the fork offset puts the axle in front of it. */
const STEER_AXIS = HEAD_TOP.clone().sub(HEAD_BOTTOM).normalize();
const STEER_PIVOT = HEAD_BOTTOM.clone();
const STEM = v3(0.405, 0.878, 0);
const HOOD = v3(0.475, 0.9, 0.205);
const DROP = v3(0.445, 0.79, 0.2);
const TOPS = v3(0.4, 0.88, 0.13);
const THIGH = 0.45;
const SHIN = 0.44;
const TORSO = 0.52;
const UPPER_ARM = 0.29;
const FOREARM = 0.28;
const HIP_W = 0.09;
const SHOULDER_W = 0.18;

/** Hip-joint centre (between the hips) for the poses; standing bobs with the stroke. */
const HIP_SEATED = v3(-0.255, 1.035, 0);
const HIP_DROPS = v3(-0.235, 1.025, 0);
const HIP_STANDING = v3(-0.03, 1.035, 0);
const HIP_STOPPED = v3(-0.17, 0.93, 0);

/** A limb segment with its pivot at the start, pointing along +y. */
class Segment {
  readonly mesh: THREE.Mesh;
  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, readonly length: number) {
    this.mesh = new THREE.Mesh(geo, mat);
    parent.add(this.mesh);
  }
  place(a: THREE.Vector3, b: THREE.Vector3): void {
    const d = b.clone().sub(a);
    const l = d.length();
    this.mesh.position.copy(a);
    this.mesh.quaternion.setFromUnitVectors(Y, d.divideScalar(l || 1));
    this.mesh.scale.set(1, Math.max(0.5, l / this.length), 1);
  }
}

/**
 * Low-poly road cyclist with a jointed body: legs by two-bone IK onto the pedals (crank angle from the
 * cadence, ankles that move through the stroke), arms by IK onto the bars, a steered front wheel,
 * lean into curves from speed and curvature, pitch on slopes, standing with a rocking bike on steep
 * climbs, drops and tuck when fast, freewheeling with level pedals (outside pedal down in curves)
 * and a foot on the ground when stopped.
 */
export class RiderModel {
  readonly group = new THREE.Group();
  private readonly pitch = new THREE.Group();
  private readonly lean = new THREE.Group();
  private readonly bike = new THREE.Group();
  private readonly steer = new THREE.Group();
  private readonly crankGroup = new THREE.Group();
  private readonly pedals: THREE.Mesh[] = [];
  private readonly wheels: THREE.Mesh[] = [];
  private readonly torso: Segment;
  private readonly neck: Segment;
  private readonly head = new THREE.Group();
  private readonly legs: { thigh: Segment; shin: Segment; shoe: THREE.Mesh; side: 1 | -1 }[] = [];
  private readonly arms: { upper: Segment; fore: Segment; hand: THREE.Mesh; side: 1 | -1 }[] = [];

  // state
  private crank = 0;
  private wheelAngle = 0;
  private leanAngle = 0;
  private steerAngle = 0;
  private pitchAngle = 0;
  private stillFor = 0;
  private standing = false;
  private readonly blend = { stand: 0, drops: 0, tuck: 0, stop: 1 };
  private initialised = false;

  constructor() {
    // depth bias above the road markings (4): the roads' own bias would otherwise cover the tyres
    const mat = retroMaterial({ snap: false, polygonOffset: RIDER.depthBias });
    const o = RIDER.outfit;
    const b = RIDER.bike;
    this.group.add(this.pitch);
    this.pitch.add(this.lean);
    this.lean.add(this.bike);

    // blob shadow (the renderer has no shadows; it keeps the bike on the road)
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 12).rotateX(-Math.PI / 2),
      new THREE.MeshBasicNodeMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    shadow.scale.set(2.3, 1, 0.7);
    shadow.position.y = 0.03;
    shadow.renderOrder = 1;
    this.group.add(shadow);

    // frame
    const down0 = HEAD_BOTTOM.clone().lerp(HEAD_TOP, 0.12);
    const ddir = down0.clone().sub(BB).normalize();
    const dn = v3(-ddir.y, ddir.x, 0);
    const mid = BB.clone().lerp(down0, 0.5);
    const frame = [
      tube(HEAD_BOTTOM, HEAD_TOP, 0.026, b.frame, 6),
      tube(SEAT, HEAD_TOP.clone().lerp(HEAD_BOTTOM, 0.15), 0.021, b.frame),
      tube(BB, down0, 0.027, b.frame),
      tube(BB, SEAT, 0.02, b.frame),
      tube(SEAT.clone().lerp(BB, 0.25), SEAT.clone().lerp(BB, 0.45), 0.023, b.frameAccent),
      ...[1, -1].flatMap((s) => [
        tube(BB.clone().setZ(s * 0.04), REAR.clone().setZ(s * 0.06), 0.012, b.frame, 4),
        tube(SEAT.clone().setZ(s * 0.02), REAR.clone().setZ(s * 0.06), 0.011, b.frame, 4),
      ]),
      tube(SEAT, v3(-0.275, 0.94, 0), 0.014, b.metal, 5),
      taper(0, 0.27, 0.05, 0.035, 0.14, 0.045, b.saddle).rotateZ(-Math.PI / 2).translate(-0.41, 0.955, 0),
      tube(mid.clone().addScaledVector(ddir, -0.1).addScaledVector(dn, 0.055), mid.clone().addScaledVector(ddir, 0.1).addScaledVector(dn, 0.055), 0.034, b.bottle, 6),
      tube(REAR.clone().setZ(0.03), REAR.clone().setZ(0.07), 0.045, b.metal, 8),
    ];
    this.bike.add(new THREE.Mesh(merged(frame), mat));

    // wheels: deep rims with decals and spokes, so the rotation shows even at low resolution
    const wheelGeo = () => {
      const parts = [
        paint(new THREE.TorusGeometry(WHEEL_R - 0.012, 0.022, 4, 20), b.tyre),
        paint(new THREE.TorusGeometry(WHEEL_R - 0.06, 0.028, 3, 20), b.rim),
        box(0.07, 0.04, 0.062, b.decal, 0, WHEEL_R - 0.06, 0),
        box(0.07, 0.04, 0.062, b.decal, 0, -(WHEEL_R - 0.06), 0),
        tube(v3(0, 0, -0.05), v3(0, 0, 0.05), 0.022, b.metal, 6),
      ];
      for (let k = 0; k < 3; k++) parts.push(box(0.008, 2 * (WHEEL_R - 0.07), 0.008, b.metal, 0, 0, 0).rotateZ((k * Math.PI) / 3));
      return merged(parts);
    };
    const rear = new THREE.Mesh(wheelGeo(), mat);
    rear.position.copy(REAR);
    this.bike.add(rear);

    // steering: fork, front wheel, stem and bars turn about the head tube axis
    this.steer.position.copy(STEER_PIVOT);
    this.bike.add(this.steer);
    const S = (p: THREE.Vector3) => p.clone().sub(STEER_PIVOT);
    const bar: THREE.BufferGeometry[] = [
      ...[1, -1].map((s) => tube(S(v3(0.345, 0.69, s * 0.045)), S(FRONT.clone().setZ(s * 0.05)), 0.014, b.fork, 4)),
      tube(S(v3(0.33, 0.69, -0.05)), S(v3(0.33, 0.69, 0.05)), 0.02, b.fork, 4),
      tube(S(HEAD_TOP), S(HEAD_TOP.clone().addScaledVector(STEER_AXIS, 0.03)), 0.02, b.bar, 6),
      tube(S(HEAD_TOP.clone().addScaledVector(STEER_AXIS, 0.025)), S(STEM), 0.017, b.bar, 5),
      tube(S(STEM.clone().setZ(-0.21)), S(STEM.clone().setZ(0.21)), 0.012, b.bar, 5),
    ];
    for (const s of [1, -1]) {
      const z = s * 0.205;
      bar.push(...tubes([STEM.clone().setZ(z), v3(0.47, 0.885, z), v3(0.49, 0.83, z), v3(0.465, 0.775, z), v3(0.4, 0.77, z)].map(S), 0.012, b.bar));
      bar.push(tube(S(v3(0.465, 0.88, z)), S(v3(0.5, 0.915, z)), 0.019, b.bar, 5));
    }
    this.steer.add(new THREE.Mesh(merged(bar), mat));
    const front = new THREE.Mesh(wheelGeo(), mat);
    front.position.copy(S(FRONT));
    this.steer.add(front);
    this.wheels.push(rear, front);

    // drivetrain
    this.crankGroup.position.copy(BB);
    this.bike.add(this.crankGroup);
    const ring = new THREE.CylinderGeometry(0.105, 0.105, 0.012, 14).rotateX(Math.PI / 2).translate(0, 0, 0.065);
    this.crankGroup.add(
      new THREE.Mesh(
        merged([
          paint(ring, 0x2a2a30),
          tube(v3(0, 0, 0.085), v3(0, CRANK, 0.085), 0.013, b.metal, 4),
          tube(v3(0, 0, -0.085), v3(0, -CRANK, -0.085), 0.013, b.metal, 4),
          tube(v3(0, 0, -0.09), v3(0, 0, 0.09), 0.018, b.metal, 6),
        ]),
        mat,
      ),
    );
    for (const s of [1, -1]) {
      const pedal = new THREE.Mesh(merged([box(0.09, 0.018, 0.075, 0x1c1c20, 0, 0, 0)]), mat);
      pedal.position.set(0, s * CRANK, s * 0.12);
      this.crankGroup.add(pedal);
      this.pedals.push(pedal);
    }

    // body
    this.torso = new Segment(
      this.lean,
      merged([
        taper(0, 0.12, 0.2, 0.21, 0.3, 0.31, o.shorts),
        taper(0.12, 0.3, 0.21, 0.22, 0.31, 0.33, o.jersey),
        taper(0.3, 0.37, 0.22, 0.225, 0.33, 0.35, o.jerseySide),
        taper(0.37, TORSO, 0.225, 0.2, 0.35, 0.4, o.jersey),
        taper(TORSO, TORSO + 0.04, 0.2, 0.16, 0.4, 0.3, o.jersey),
      ]),
      mat,
      TORSO,
    );
    this.neck = new Segment(this.lean, merged([tube(v3(0, 0, 0), v3(0, 0.1, 0), 0.045, o.skin, 5)]), mat, 0.1);
    this.lean.add(this.head);
    const helmet = new THREE.SphereGeometry(0.112, 8, 5).scale(1.3, 0.74, 1.0).translate(-0.01, 0.11, 0);
    this.head.add(
      new THREE.Mesh(
        merged([
          box(0.16, 0.17, 0.135, o.skin, 0.02, 0.045, 0),
          paint(helmet, o.helmet),
          box(0.18, 0.022, 0.055, o.helmetStripe, -0.01, 0.192, 0),
          box(0.03, 0.035, 0.15, o.glasses, 0.1, 0.07, 0),
        ]),
        mat,
      ),
    );
    for (const side of [1, -1] as const) {
      const thigh = new Segment(this.lean, merged([tube(v3(0, 0, 0), v3(0, THIGH, 0), 0.078, o.shorts, 6, 0.058)]), mat, THIGH);
      const shin = new Segment(
        this.lean,
        merged([tube(v3(0, 0, 0), v3(0, SHIN * 0.72, 0), 0.056, o.skin, 6, 0.042), tube(v3(0, SHIN * 0.72, 0), v3(0, SHIN, 0), 0.042, o.socks, 6, 0.036)]),
        mat,
        SHIN,
      );
      const shoe = new THREE.Mesh(merged([taper(0, 0.26, 0.075, 0.05, 0.095, 0.08, o.shoes).rotateZ(-Math.PI / 2)]), mat);
      this.lean.add(shoe);
      this.legs.push({ thigh, shin, shoe, side });
      const upper = new Segment(
        this.lean,
        merged([tube(v3(0, 0, 0), v3(0, 0.13, 0), 0.052, o.jersey, 6, 0.046), tube(v3(0, 0.13, 0), v3(0, UPPER_ARM, 0), 0.042, o.skin, 6, 0.036)]),
        mat,
        UPPER_ARM,
      );
      const fore = new Segment(this.lean, merged([tube(v3(0, 0, 0), v3(0, FOREARM, 0), 0.036, o.skin, 5, 0.03)]), mat, FOREARM);
      const hand = new THREE.Mesh(merged([box(0.09, 0.05, 0.06, o.gloves, 0.03, 0, 0)]), mat);
      this.lean.add(hand);
      this.arms.push({ upper, fore, hand, side });
    }
    this.group.scale.setScalar(1.05);
  }

  update(s: RiderInput): void {
    const dt = Math.min(0.1, Math.max(0, s.dt));
    const k = (tau: number) => (this.initialised ? 1 - Math.exp(-dt / tau) : 1);
    const v = s.v;

    // --- placement: heading from the line tangent, pitch from the grade, lean from curvature
    this.group.position.set(s.x, s.y, s.z);
    this.group.rotation.y = -Math.atan2(s.tz, s.tx);
    this.pitchAngle += (Math.atan(s.grade) - this.pitchAngle) * k(0.25);
    this.pitch.rotation.z = this.pitchAngle;

    this.stillFor = v < RIDER.stopSpeed ? this.stillFor + dt : 0;
    const stopped = this.stillFor > RIDER.stopDelay || !this.initialised;
    const pedalling = s.cadence > 0 && v >= RIDER.stopSpeed;
    if (this.standing) this.standing = s.grade > RIDER.sitGrade && v < RIDER.standSpeed + 1 && pedalling;
    else this.standing = s.grade > RIDER.standGrade && v < RIDER.standSpeed && pedalling;

    const bl = this.blend;
    const kp = k(RIDER.poseTau);
    bl.stop += ((stopped ? 1 : 0) - bl.stop) * k(stopped ? 0.35 : 0.2);
    bl.stand += ((this.standing ? 1 : 0) - bl.stand) * kp;
    bl.drops += (smoothstep(RIDER.dropsSpeed - 1.5, RIDER.dropsSpeed + 1.5, v) - bl.drops) * kp;
    bl.tuck += ((!pedalling && v > RIDER.tuckSpeed ? 1 : 0) - bl.tuck) * kp;

    const leanTarget = Math.max(-RIDER.maxLean, Math.min(RIDER.maxLean, Math.atan((v * v * s.kAhead) / 9.81)));
    this.leanAngle += (leanTarget * (1 - bl.stop) - 0.1 * bl.stop - this.leanAngle) * k(RIDER.leanTau);
    this.lean.rotation.x = this.leanAngle;
    const steerTarget = Math.atan((FRONT.x - REAR.x) * s.k) * (1 - bl.stop) + 0.12 * bl.stop;
    this.steerAngle += (steerTarget - this.steerAngle) * k(RIDER.steerTau);
    this.steer.quaternion.setFromAxisAngle(STEER_AXIS, -this.steerAngle);

    // --- crank: from the cadence while pedalling; freewheeling it settles level, or with the
    // outside pedal down in a curve, or ready to push off (right pedal forward) when stopped
    if (pedalling) this.crank += (s.cadence / 60) * Math.PI * 2 * dt;
    else {
      let target: number;
      if (bl.stop > 0.5) target = 1.0;
      else if (Math.abs(this.leanAngle) > 0.12) target = this.leanAngle < 0 ? Math.PI : 0;
      else target = Math.round((this.crank - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
      const diff = wrapPi(target - this.crank);
      this.crank += Math.sign(diff) * Math.min(Math.abs(diff), 3 * dt);
    }
    const c = this.crank;
    this.crankGroup.rotation.z = -c;
    this.wheelAngle -= (v * dt) / WHEEL_R;
    for (const w of this.wheels) w.rotation.z = this.wheelAngle;

    // standing: the bike rocks away from the pushing leg
    const rock = -RIDER.rock * bl.stand * Math.sin(c);
    this.bike.rotation.x = rock;

    this.lean.updateMatrix();
    this.bike.updateMatrix();
    this.steer.updateMatrix();
    const toLean = (p: THREE.Vector3) => p.applyMatrix4(this.bike.matrix);
    const fromSteer = (p: THREE.Vector3) => toLean(p.sub(STEER_PIVOT).applyMatrix4(this.steer.matrix));

    // --- hips and torso
    const hip = HIP_SEATED.clone().lerp(HIP_DROPS, bl.drops);
    hip.lerp(HIP_STANDING.clone().setY(HIP_STANDING.y + 0.025 * Math.cos(2 * c)), bl.stand);
    hip.lerp(HIP_STOPPED, bl.stop);
    const slow = 1 - smoothstep(2, 6, v);
    let angle = 38 + 7 * slow;
    angle += (31 - angle) * bl.drops;
    angle += (20 - angle) * bl.tuck;
    angle += (33 - angle) * bl.stand;
    angle += (64 - angle) * bl.stop;
    const a = (angle * Math.PI) / 180;
    const sway = 0.012 * Math.sin(c) * (1 - bl.stop) * (1 + 3 * bl.stand);
    const tdir = v3(Math.cos(a), Math.sin(a), sway).normalize();
    const shoulder = hip.clone().addScaledVector(tdir, TORSO);
    this.torso.place(hip, shoulder);
    // the shoulders sit a little below the top of the torso box
    const shoulderC = hip.clone().addScaledVector(tdir, TORSO - 0.03);

    // --- head: looks up the road and into the curve, keeps the horizon level-ish
    const neckTop = shoulderC.clone().add(v3(0.07, 0.06, 0));
    this.neck.place(shoulderC, neckTop);
    this.head.position.copy(neckTop);
    this.head.rotation.set(-this.leanAngle * 0.35, Math.max(-0.5, Math.min(0.5, -s.kAhead * 4)), 0.1 * bl.tuck - 0.05 * bl.stop, 'YXZ');

    // --- legs onto the pedals (the left one onto the ground when stopped)
    for (const leg of this.legs) {
      const ph = leg.side > 0 ? 0 : Math.PI;
      const ca = c + ph;
      const ankling = -0.15 + 0.2 * Math.sin(ca);
      const pedal = toLean(v3(BB.x + Math.sin(ca) * CRANK, BB.y + Math.cos(ca) * CRANK, leg.side * 0.11));
      let ang = ankling;
      let ball = pedal;
      if (leg.side < 0 && bl.stop > 0.01) {
        // foot on the ground beside the bike: undo the lean (the ground is level in the pitch frame)
        const ground = v3(-0.02, 0.01, -0.42).applyMatrix4(this.lean.matrix.clone().invert());
        ball = pedal.clone().lerp(ground, bl.stop);
        ang = ankling * (1 - bl.stop) + 0.05 * bl.stop;
      }
      const ca2 = Math.cos(ang);
      const sa2 = Math.sin(ang);
      const R = (x: number, y: number) => v3(x * ca2 - y * sa2, x * sa2 + y * ca2, 0);
      const ankle = ball.clone().add(R(-0.085, 0.075));
      const hipJ = hip.clone().setZ(hip.z + leg.side * HIP_W);
      hipJ.y += 0.008 * Math.sin(ca) * (1 - bl.stop);
      const knee = new THREE.Vector3();
      ik(hipJ, ankle, THIGH, SHIN, v3(1, 0.1, leg.side * 0.12), knee);
      leg.thigh.place(hipJ, knee);
      const shinEnd = knee.clone().add(ankle.clone().sub(knee).setLength(SHIN));
      leg.shin.place(knee, shinEnd);
      // shoe from the heel to beyond the ball of the foot, sole along the ankling angle
      const heel = ball.clone().add(R(-0.17, 0.035));
      leg.shoe.position.copy(heel);
      leg.shoe.rotation.set(0, 0, ang);
      leg.shoe.position.z = ball.z;
    }
    this.pedals[0]!.rotation.z = c - 0.15 + 0.2 * Math.sin(c);
    this.pedals[1]!.rotation.z = c - 0.15 + 0.2 * Math.sin(c + Math.PI);

    // --- arms onto the hoods / drops / tops
    for (const arm of this.arms) {
      const z = arm.side;
      const grip = HOOD.clone().setZ(z * HOOD.z).lerp(DROP.clone().setZ(z * DROP.z), bl.drops);
      grip.lerp(TOPS.clone().setZ(z * TOPS.z), bl.tuck);
      const g = fromSteer(grip);
      const sh = shoulderC.clone().add(v3(-0.02, -0.02, z * SHOULDER_W));
      const wrist = g.clone().add(v3(-0.05, 0.015, 0));
      const elbow = new THREE.Vector3();
      ik(sh, wrist, UPPER_ARM, FOREARM, v3(-0.25, -0.5, z * 0.85), elbow);
      arm.upper.place(sh, elbow);
      const fEnd = elbow.clone().add(wrist.clone().sub(elbow).setLength(FOREARM));
      arm.fore.place(elbow, fEnd);
      arm.hand.position.copy(fEnd);
      arm.hand.rotation.set(0, 0, -0.3);
    }
    this.initialised = true;
  }
}
