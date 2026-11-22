import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, smoothstep } from 'three/tsl';
import { BUILDING, RENDER } from '../config';
import type { TileMesh } from '../workers/world-worker';
import { retroMaterial, texturedRetroMaterial } from './retro';
import { ATLAS, buildingAtlas } from './textures';

function lights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x55663a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.position.set(...RENDER.sunDirection);
  scene.add(sun);
}

/**
 * Two scenes, drawn in two depth passes (PLAN.md, Renderer): `far` holds the sky and the
 * levels L2–L4, `near` L0 and L1 with roads, buildings and trees, drawn on top. Both share the haze.
 */
export function createScenes(): { near: THREE.Scene; far: THREE.Scene } {
  const near = new THREE.Scene();
  const far = new THREE.Scene();
  for (const s of [near, far]) {
    s.fog = new THREE.Fog(RENDER.sky.horizon, RENDER.hazeNear, RENDER.hazeFar);
    lights(s);
  }
  far.background = new THREE.Color(RENDER.sky.horizon);
  // sky dome: gradient from the horizon (= haze colour) to the zenith; follows the camera
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(RENDER.farPassFar * 0.9, 16, 10),
    new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  (sky.material as THREE.MeshBasicNodeMaterial).colorNode = mix(
    color(RENDER.sky.horizon),
    color(RENDER.sky.zenith),
    smoothstep(0.0, 0.45, positionLocal.normalize().y),
  );
  sky.name = 'sky';
  sky.renderOrder = -1;
  far.add(sky);
  return { near, far };
}

function geometry(position: Float32Array, col: Float32Array | Uint8Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  // terrain colours come as normalised RGBA bytes, the rest as float RGB
  g.setAttribute('color', col instanceof Uint8Array ? new THREE.BufferAttribute(col, 4, true) : new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

const terrainMat = retroMaterial();
const coarseMat = retroMaterial({ curvature: true });
// plain colours by default (the facade textures looked restless and alike); BUILDING.textures switches them on
const buildingMat = BUILDING.textures
  ? texturedRetroMaterial(buildingAtlas(), ATLAS.cols, ATLAS.rows, { side: THREE.DoubleSide })
  : retroMaterial({ side: THREE.DoubleSide });
const roadMat = retroMaterial({ side: THREE.DoubleSide, polygonOffset: 2, snap: false });
// bands are drawn in class order; at equal depth the later (bigger) road wins
roadMat.depthFunc = THREE.LessEqualDepth;
const roadMarkMat = retroMaterial({ side: THREE.DoubleSide, polygonOffset: 4, snap: false });
const sceneryMat = retroMaterial({ side: THREE.DoubleSide, polygonOffset: 2, snap: false });

/** The meshes of one streamed tile: terrain chunks (hidden where a finer tile is loaded) and buildings. */
export interface TileView {
  group: THREE.Group;
  chunks: THREE.Mesh[];
}

export function tileView(t: TileMesh): TileView {
  const group = new THREE.Group();
  const chunks = t.terrain.map((c) => new THREE.Mesh(geometry(c.position, c.color), t.level === 0 ? terrainMat : coarseMat));
  for (const m of chunks) group.add(m);
  if (t.buildings.position.length) {
    const g = geometry(t.buildings.position, t.buildings.color);
    g.setAttribute('tex', new THREE.BufferAttribute(t.buildings.tex, 3));
    group.add(new THREE.Mesh(g, buildingMat));
  }
  if (t.roads?.position.length) group.add(new THREE.Mesh(geometry(t.roads.position, t.roads.color), roadMat));
  if (t.marks?.position.length) group.add(new THREE.Mesh(geometry(t.marks.position, t.marks.color), roadMarkMat));
  if (t.scenery?.position.length) group.add(new THREE.Mesh(geometry(t.scenery.position, t.scenery.color), sceneryMat));
  return { group, chunks };
}

export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
  });
  g.removeFromParent();
}


export { nodeHeight, roadHeight, roadLift } from './roads';
