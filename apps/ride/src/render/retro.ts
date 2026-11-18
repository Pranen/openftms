import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraProjectionMatrix,
  float,
  floor,
  mix,
  modelViewMatrix,
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

/** Flat-shaded vertex-colour material with PS1 vertex snapping. */
export function retroMaterial(opts: { side?: THREE.Side; polygonOffset?: number } = {}): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial({ vertexColors: true, flatShading: true, side: opts.side ?? THREE.FrontSide });
  if (opts.polygonOffset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -opts.polygonOffset;
    m.polygonOffsetUnits = -opts.polygonOffset;
  }
  m.vertexNode = Fn(() => {
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1)).toVar();
    const snapped = floor(clip.xy.div(clip.w).mul(snapGrid).add(0.5)).div(snapGrid).mul(clip.w);
    return vec4(snapped, clip.z, clip.w);
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

  async init(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    await this.renderer.init();
    this.renderer.setPixelRatio(1);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
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
    this.pipeline.render();
  }
}
