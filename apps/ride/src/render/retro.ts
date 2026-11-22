import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  varyingProperty,
  vec2,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  floor,
  mix,
  modelWorldMatrix,
  pass,
  positionLocal,
  screenCoordinate,
  texture,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { RENDER } from '../config';

/**
 * PS1 look (after C:/data/ski/src/render/retro-pass.ts):
 *  - low internal resolution, upscaled by CSS with `image-rendering: pixelated`
 *  - colours quantised per channel with a 4×4 ordered (Bayer) dither (32 levels = 15-bit colour)
 *  - vertex snapping to a coarse screen grid (subtle, switchable: long rides!)
 */

function bayerTexture(): THREE.DataTexture {
  const m = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const data = new Uint8Array(16 * 4);
  m.forEach((v, i) => {
    const b = Math.round(((v + 0.5) / 16) * 255);
    data.set([b, b, b, 255], i * 4);
  });
  const tex = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Screen grid for vertex snapping (in NDC units per half screen); huge = off. */
const snapGrid = uniform(new THREE.Vector2(1e6, 1e6));
/** 1 = affine texture mapping (PS1 swimming textures), 0 = perspective-correct; follows the snapping switch. */
const affine = uniform(RENDER.vertexSnap > 0 ? 1 : 0);

/** Clip-space position with optional earth curvature and vertex snapping (call inside an Fn). */
function clipNode(opts: { curvature?: boolean; snap?: boolean }) {
  const world = modelWorldMatrix.mul(vec4(positionLocal, 1)).toVar();
  let y = world.y;
  if (opts.curvature) {
    const d = world.xz.sub(cameraPosition.xz).length();
    y = y.sub(d.mul(d).mul((1 - RENDER.refraction) / (2 * RENDER.earthRadius)));
  }
  const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world.x, y, world.z, 1)).toVar();
  if (opts.snap === false) return clip;
  const snapped = floor(clip.xy.div(clip.w).mul(snapGrid).add(0.5)).div(snapGrid).mul(clip.w);
  return vec4(snapped, clip.z, clip.w);
}

/**
 * Flat-shaded vertex-colour material with PS1 vertex snapping (`snap: false` for long thin
 * bands like roads and their markings, which snapping bends into a zigzag). `curvature`: the earth's
 * apparent drop relative to the camera (for the panorama: far summits sink like in reality).
 */
export function retroMaterial(
  opts: { side?: THREE.Side; polygonOffset?: number; curvature?: boolean; snap?: boolean } = {},
): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial({ vertexColors: true, flatShading: true, side: opts.side ?? THREE.FrontSide });
  if (opts.polygonOffset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -opts.polygonOffset;
    m.polygonOffsetUnits = -opts.polygonOffset;
  }
  m.vertexNode = Fn(() => clipNode(opts))();
  return m;
}

/**
 * Retro material with a pixel texture from an atlas (buildings): the `tex` attribute holds (u, v, tile); u and v
 * repeat inside the tile. Affine mapping like the PS1 (textures swim on big faces at grazing angles): the
 * texture coordinates are interpolated as uv·w and w – the perspective-correct interpolation of both divided
 * gives the screen-linear (affine) value. The vertex colour tints the light texture.
 */
export function texturedRetroMaterial(atlas: THREE.Texture, cols: number, rows: number, opts: { side?: THREE.Side } = {}): THREE.MeshLambertNodeMaterial {
  const m = retroMaterial(opts);
  const tex = attribute<'vec3'>('tex', 'vec3');
  const vUvw = varyingProperty('vec3', 'vUvw');
  const vW = varyingProperty('float', 'vW');
  m.vertexNode = Fn(() => {
    const clip = clipNode({}).toVar();
    const w = mix(float(1), clip.w, affine);
    vUvw.assign(vec3(tex.xy.mul(w), tex.z));
    vW.assign(w);
    return clip;
  })();
  m.colorNode = Fn(() => {
    const uv = vUvw.xy.div(vW);
    const tile = floor(vUvw.z.add(0.5));
    const col = tile.mod(cols);
    const row = floor(tile.div(cols));
    const f = uv.fract();
    const st = vec2(col.add(f.x).div(cols), row.add(float(1).sub(f.y)).div(rows));
    return texture(atlas, st).rgb.mul(attribute<'vec3'>('color', 'vec3'));
  })();
  return m;
}

export class RetroRenderer {
  readonly renderer: THREE.WebGPURenderer;
  private pipeline!: THREE.RenderPipeline;
  private readonly uLevels = uniform(RENDER.colorLevels);
  private readonly uDither = uniform(1);
  snap = RENDER.vertexSnap;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  }

  /** Far pass (sky, panorama) first, then the near world on top with its own depth buffer. */
  readonly farCamera = new THREE.PerspectiveCamera(RENDER.fovDeg, 1, RENDER.farPassNear, RENDER.farPassFar);
  private camera!: THREE.PerspectiveCamera;

  async init(near: THREE.Scene, far: THREE.Scene, camera: THREE.PerspectiveCamera): Promise<void> {
    await this.renderer.init();
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0); // near pass: transparent where it draws nothing
    this.camera = camera;
    const farColor = pass(far, this.farCamera).getTextureNode('output');
    const nearColor = pass(near, camera).getTextureNode('output');
    const color = mix(farColor, nearColor, nearColor.a);
    const bayer = texture(bayerTexture(), screenCoordinate.xy.div(4));
    const levels = this.uLevels;
    const dither = this.uDither;
    const output = Fn(() => {
      const srgb = color.rgb.clamp(0, 1).pow(vec3(1 / 2.2));
      const steps = levels.sub(1);
      const offset = mix(float(0.5), bayer.r, dither);
      return vec4(floor(srgb.mul(steps).add(offset)).div(steps), 1);
    })();
    this.pipeline = new THREE.RenderPipeline(this.renderer, output);
    this.pipeline.outputColorTransform = false; // converted to sRGB above, before quantising
  }

  get backendName(): string {
    const backend = (this.renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
    return backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  resize(width: number, height: number, camera: THREE.PerspectiveCamera): void {
    if (width < 1 || height < 1) return;
    const h = Math.min(RENDER.internalHeight, height);
    const w = Math.round((width / height) * h);
    this.renderer.setSize(w, h, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    this.applySnap(w, h);
  }

  private applySnap(w: number, h: number): void {
    if (this.snap > 0) snapGrid.value.set((w / 2) * this.snap, (h / 2) * this.snap);
    else snapGrid.value.set(1e6, 1e6);
    affine.value = this.snap > 0 ? 1 : 0;
  }

  toggleSnap(): void {
    this.snap = this.snap > 0 ? 0 : RENDER.vertexSnap;
    const size = this.renderer.getSize(new THREE.Vector2());
    this.applySnap(size.x, size.y);
  }

  toggleDither(): void {
    this.uDither.value = this.uDither.value > 0 ? 0 : 1;
  }

  render(): void {
    const c = this.camera;
    const f = this.farCamera;
    f.position.copy(c.position);
    f.quaternion.copy(c.quaternion);
    if (f.fov !== c.fov || f.aspect !== c.aspect) {
      f.fov = c.fov;
      f.aspect = c.aspect;
      f.updateProjectionMatrix();
    }
    f.updateMatrixWorld();
    this.pipeline.render();
  }
}
