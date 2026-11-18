import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, smoothstep } from 'three/tsl';
import { SEC_TUNNEL, type RouteGraph } from 'route-graph';
import { GRAVEL_COLOR, RENDER, ROAD_COLOR, ROAD_COLOR_DEFAULT } from '../config';
import type { TileMesh } from '../workers/world-worker';
import { retroMaterial } from './retro';

/** Scene with sky, sun, fog and the static world (terrain, roads, buildings). */
export function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(RENDER.sky.horizon);
  scene.fog = new THREE.Fog(RENDER.sky.horizon, RENDER.fogNear, RENDER.fogFar);
  scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x55663a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.position.set(...RENDER.sunDirection);
  scene.add(sun);
  // sky dome: gradient from the horizon (= fog colour) to the zenith; follows the camera
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(RENDER.far * 0.9, 16, 10),
    new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  (sky.material as THREE.MeshBasicNodeMaterial).colorNode = mix(
    color(RENDER.sky.horizon),
    color(RENDER.sky.zenith),
    smoothstep(0.0, 0.45, positionLocal.normalize().y),
  );
  sky.name = 'sky';
  sky.renderOrder = -1;
  scene.add(sky);
  return scene;
}

function geometry(position: Float32Array, col: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

const terrainMat = retroMaterial();
const buildingMat = retroMaterial({ side: THREE.DoubleSide });
const roadMat = retroMaterial({ side: THREE.DoubleSide, polygonOffset: 2 });

export function addTile(scene: THREE.Scene, t: TileMesh): void {
  scene.add(new THREE.Mesh(geometry(t.terrain.position, t.terrain.color), terrainMat));
  if (t.buildings.position.length) scene.add(new THREE.Mesh(geometry(t.buildings.position, t.buildings.color), buildingMat));
}

const lin = (hex: number) => new THREE.Color(hex);

/** Road bands of the whole ride network, built from the graph (same profile as the physics). */
export function addRoads(scene: THREE.Scene, g: RouteGraph): void {
  const pos: number[] = [];
  const col: number[] = [];
  const order = [...Array(g.edgeCount).keys()].sort((a, b) => g.edgeClass(a) - g.edgeClass(b));
  for (const e of order) {
    const L = g.length(e);
    const hw = g.halfWidth(e);
    const surf = g.surface(e);
    const c = lin(surf >= 3 && surf <= 5 ? GRAVEL_COLOR : (ROAD_COLOR[g.edgeClass(e)] ?? ROAD_COLOR_DEFAULT));
    const lift = RENDER.roadLift + g.edgeClass(e) * 0.01;
    const tunnels = g.sections(e).filter((s) => s.flags & SEC_TUNNEL);
    const n = Math.max(1, Math.ceil(L / 4));
    let prev: number[] | null = null;
    for (let k = 0; k <= n; k++) {
      const s = (L * k) / n;
      const p = g.point(e, s);
      const y = g.height(e, s) + lift;
      const nx = -p.tz * hw;
      const nz = p.tx * hw;
      const cur = [p.x + nx, y, p.z + nz, p.x - nx, y, p.z - nz];
      const inTunnel = tunnels.some((t) => s > t.start && s < t.end);
      if (prev && !inTunnel) {
        const [ax, ay, az, bx, by, bz] = prev as [number, number, number, number, number, number];
        const [cx, cy, cz, dx, dy, dz] = cur as [number, number, number, number, number, number];
        pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, bx, by, bz, dx, dy, dz, cx, cy, cz);
        for (let v = 0; v < 6; v++) col.push(c.r, c.g, c.b);
      }
      prev = cur;
    }
  }
  scene.add(new THREE.Mesh(geometry(new Float32Array(pos), new Float32Array(col)), roadMat));
}
