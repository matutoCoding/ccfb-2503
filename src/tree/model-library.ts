import * as THREE from 'three';
import type { TreeSpecies } from '../core/types';
import { generateTreeModel, variantSeed, VARIANT_COUNT, type TreeModel } from './generator';
import { createBranchMaterial, createFoliageMaterial, createSpeciesLook, createBillboardMaterial } from './materials';

/** 树种运行时资源包：4 变体几何 + 材质 + 公告板 */
export interface SpeciesAsset {
  species: TreeSpecies;
  models: TreeModel[];
  branchMat: THREE.MeshStandardMaterial;
  foliageMat: THREE.MeshStandardMaterial;
  billboardMat: THREE.ShaderMaterial;
  /** 公告板纹理（变体横向图集） */
  billboardTexture: THREE.Texture;
  seasonUniforms: Record<string, THREE.IUniform>;
  windPhase: number;
  /** 实例级冠幅微抖动系数（由树种子决定，确定性） */
  jitterFor: (treeSeed: number) => number;
}

let sharedRenderer: THREE.WebGLRenderer | null = null;
function getSharedRenderer(): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: false });
    sharedRenderer.setPixelRatio(1);
    sharedRenderer.setClearColor(0x000000, 0);
  }
  return sharedRenderer;
}

/** 离屏渲染所有变体，产出横向图集的公告板纹理（透明背景） */
function renderBillboard(sp: TreeSpecies, models: TreeModel[]): THREE.Texture {
  const renderer = getSharedRenderer();
  const TILE = 256;
  const width = TILE * models.length;
  const height = TILE;
  // 每变体独立 RT，避免 scissor 分块导致的投影错位
  const rt = new THREE.WebGLRenderTarget(TILE, TILE, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const scene = new THREE.Scene();
  // 单位化树高=1、基部 y=0、顶部约 y=1.1。相机水平正视（不俯视），
  // 垂直视野 [-0.15, 1.25] 容纳整树，水平视野按 TILE 宽高比收窄
  const halfH = 0.7;
  const halfW = halfH; // 方形图块
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 10);
  camera.position.set(0, 0.55, 2.2);
  camera.lookAt(0, 0.55, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const dir = new THREE.DirectionalLight(0xfff4e0, 1.6);
  dir.position.set(2, 3, 2);
  scene.add(dir);

  const { uniforms } = createSpeciesLook(sp, 0.55); // 按夏季叶色烘焙
  const foliageMat = createFoliageMaterial(uniforms, 0);
  const branchMat = createBranchMaterial(0x6b5240, 0);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const buf = new Uint8Array(TILE * TILE * 4);

  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);

  models.forEach((model, idx) => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(model.lodLow.branch, branchMat));
    group.add(new THREE.Mesh(model.lodLow.foliage, foliageMat));
    scene.add(group);
    renderer.clear();
    renderer.render(scene, camera);
    scene.remove(group);
    // RT 像素自下而上，翻转后绘制到图集对应图块
    renderer.readRenderTargetPixels(rt, 0, 0, TILE, TILE, buf);
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = TILE;
    tileCanvas.height = TILE;
    const tctx = tileCanvas.getContext('2d')!;
    const image = tctx.createImageData(TILE, TILE);
    for (let y = 0; y < TILE; y++) {
      const src = (TILE - 1 - y) * TILE * 4;
      image.data.set(buf.subarray(src, src + TILE * 4), y * TILE * 4);
    }
    tctx.putImageData(image, 0, 0);
    ctx.drawImage(tileCanvas, idx * TILE, 0);
  });

  renderer.setRenderTarget(null);
  rt.dispose();
  foliageMat.dispose();
  branchMat.dispose();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

const cache = new Map<string, SpeciesAsset>();
const loading = new Map<string, Promise<SpeciesAsset>>();

export function getCachedAsset(speciesId: string): SpeciesAsset | undefined {
  return cache.get(speciesId);
}

/** 同步预生成（主线程，约 20~60ms/树种） */
export function loadSpeciesAsset(sp: TreeSpecies, seasonT: number): SpeciesAsset {
  const hit = cache.get(sp.id);
  if (hit) return hit;

  const models: TreeModel[] = [];
  for (let v = 0; v < VARIANT_COUNT; v++) {
    models.push(generateTreeModel(sp, v, VARIANT_COUNT));
  }
  const seed = variantSeed(sp);
  const windPhase = (seed % 1000) / 1000 * Math.PI * 2;
  const { uniforms } = createSpeciesLook(sp, seasonT);
  const branchMat = createBranchMaterial(models[0].barkColor, windPhase);
  const foliageMat = createFoliageMaterial(uniforms, windPhase);
  const billboardTexture = renderBillboard(sp, models);
  const billboardMat = createBillboardMaterial(billboardTexture, windPhase);

  const asset: SpeciesAsset = {
    species: sp,
    models,
    branchMat,
    foliageMat,
    billboardMat,
    billboardTexture,
    seasonUniforms: uniforms,
    windPhase,
    jitterFor: (treeSeed) => {
      // 树种子 → 冠幅 ±8% 微抖动，确定性
      const x = Math.sin(treeSeed * 127.1 + seed * 311.7) * 43758.5453;
      return 1 + (x - Math.floor(x) - 0.5) * 0.16;
    },
  };
  cache.set(sp.id, asset);
  return asset;
}

/** 异步队列预热（避免首帧卡顿），onProgress 回调进度 */
export async function prewarmSpecies(
  species: TreeSpecies[],
  seasonT: number,
  onProgress?: (done: number, total: number) => void,
): Promise<SpeciesAsset[]> {
  const pending = species.filter((s) => !cache.has(s.id));
  const out: SpeciesAsset[] = [];
  for (let i = 0; i < pending.length; i++) {
    let p = loading.get(pending[i].id);
    if (!p) {
      p = new Promise((resolve) => {
        // 让出事件循环，保持 UI 响应
        setTimeout(() => resolve(loadSpeciesAsset(pending[i], seasonT)), 0);
      });
      loading.set(pending[i].id, p);
    }
    out.push(await p);
    onProgress?.(i + 1, pending.length);
  }
  return out;
}

export function disposeAllAssets(): void {
  cache.forEach((asset) => {
    asset.models.forEach((m) => {
      m.lodHigh.branch.dispose();
      m.lodHigh.foliage.dispose();
      m.lodLow.branch.dispose();
      m.lodLow.foliage.dispose();
    });
    asset.branchMat.dispose();
    asset.foliageMat.dispose();
    asset.billboardMat.dispose();
    asset.billboardTexture.dispose();
  });
  cache.clear();
  loading.clear();
}
