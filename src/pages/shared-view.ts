import * as THREE from 'three';
import type { AppStore } from '../core/store';
import { SceneManager } from '../scene/scene-manager';
import { TreeField } from '../tree/tree-field';
import { prewarmSpecies, getCachedAsset, type SpeciesAsset } from '../tree/model-library';
import { updateSpeciesLook } from '../tree/materials';
import type { TreeSpecies } from '../core/types';

export interface ViewHandle {
  scene: SceneManager;
  field: TreeField;
  dispose(): void;
  ensureSpecies(species: TreeSpecies[]): Promise<void>;
  refreshSeason(): void;
  refreshMatrices(): void;
  refreshLod(): void;
  refreshZones(): void;
  setLoading(show: boolean, text?: string, progress?: number): void;
  onPick(cb: (treeId: number | null) => void): void;
}

/**
 * 组装一个页面级 3D 视图：场景 + 实例树场 + 资源预热 + 事件接线。
 * 页面切换时整体 dispose，保证 WebGL 资源不泄漏。
 */
export function createView(container: HTMLElement, store: AppStore, opts?: { autoPrewarm?: boolean }): ViewHandle {
  const scene = new SceneManager(container, () => store.data);
  const field = new TreeField(() => store.data, store.speciesMap);
  scene.scene.add(field.group);
  scene.rebuildZones();
  scene.updateSun();
  scene.setQuality(store.data.settings.quality);

  const loadingEl = document.createElement('div');
  loadingEl.className = 'loading-mask';
  loadingEl.innerHTML = `<div class="spinner"></div><div class="muted" data-text>正在生成树木模型…</div><div class="progress"><div style="width:0%"></div></div>`;
  loadingEl.style.display = 'none';
  container.appendChild(loadingEl);

  /* ---------- 资源预热 ---------- */
  let warmSeq = 0;
  async function ensureSpecies(species: TreeSpecies[]): Promise<void> {
    const seq = ++warmSeq;
    const missing = species.filter((s) => !getCachedAsset(s.id));
    if (!missing.length) return;
    setLoading(true, `正在生成 ${missing.length} 个树种模型…`, 0);
    await prewarmSpecies(missing, store.data.settings.seasonT, (done, total) => {
      if (seq !== warmSeq) return;
      const pct = Math.round((done / total) * 100);
      loadingEl.querySelector('[data-text]')!.textContent = `正在生成树木模型 ${done}/${total}`;
      (loadingEl.querySelector('.progress > div') as HTMLElement).style.width = `${pct}%`;
    });
    if (seq !== warmSeq) return;
    setLoading(false);
    field.markStructural();
    refreshSeason();
  }

  if (opts?.autoPrewarm !== false) {
    ensureSpecies(store.species).catch(() => undefined);
  }

  /* ---------- 拾取 ---------- */
  const raycaster = new THREE.Raycaster();
  let pickCb: ((id: number | null) => void) | null = null;
  const down = { x: 0, y: 0 };
  scene.renderer.domElement.addEventListener('pointerdown', (e) => {
    down.x = e.clientX;
    down.y = e.clientY;
  });
  scene.renderer.domElement.addEventListener('pointerup', (e) => {
    // 拖拽轨道时不触发拾取
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const rect = scene.renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
      scene.camera,
    );
    const id = field.pick(raycaster);
    pickCb?.(id);
  });

  /* ---------- 每帧 ---------- */
  scene.onFrame(() => {
    field.update(scene.camera, store.data.settings.quality);
  });

  /* ---------- store 事件 ---------- */
  const offs: (() => void)[] = [];
  offs.push(store.emitter.on((e) => {
    if (e.kind === 'structure') {
      field.setConflicts(store.conflicts);
      field.setSelected(store.selectedTreeId);
      field.markStructural();
    } else if (e.kind === 'matrix') {
      field.setConflicts(store.conflicts);
      field.setSelected(store.selectedTreeId);
      field.markMatrix();
    } else if (e.kind === 'lod') {
      field.markLod();
    } else if (e.kind === 'season') {
      refreshSeason();
    } else if (e.kind === 'zones') {
      scene.rebuildZones();
    } else if (e.kind === 'settings') {
      scene.updateSun();
    } else if (e.kind === 'project') {
      scene.rebuildZones();
      scene.rebuildGround();
      field.setConflicts(store.conflicts);
      field.markStructural();
      refreshSeason();
    }
  }));

  function refreshSeason(): void {
    const t = store.data.settings.seasonT;
    for (const sp of store.species) {
      const asset: SpeciesAsset | undefined = getCachedAsset(sp.id);
      if (!asset) continue;
      updateSpeciesLook(sp, assetFoliageLook(asset), asset.seasonUniforms, t);
    }
  }

  function refreshMatrices(): void {
    field.markMatrix();
  }

  function refreshLod(): void {
    field.markLod();
  }

  function refreshZones(): void {
    scene.rebuildZones();
  }

  function setLoading(show: boolean, text?: string, progress?: number): void {
    loadingEl.style.display = show ? 'flex' : 'none';
    if (text) loadingEl.querySelector('[data-text]')!.textContent = text;
    if (progress != null) (loadingEl.querySelector('.progress > div') as HTMLElement).style.width = `${progress}%`;
  }

  const handle: ViewHandle = {
    scene,
    field,
    dispose: () => {
      offs.forEach((off) => off());
      scene.dispose();
      field.dispose();
      loadingEl.remove();
      window.__view = undefined;
    },
    ensureSpecies,
    refreshSeason,
    refreshMatrices,
    refreshLod,
    refreshZones,
    setLoading,
    onPick: (cb) => { pickCb = cb; },
  };
  window.__view = handle;
  return handle;
}

declare global {
  interface Window { __view?: ViewHandle }
}

// SpeciesLook 对象存在材质闭包内，这里从 uniform 反查不便，
// 故直接通过 uniforms 更新即可（颜色对象是同一个引用），此函数仅用于类型占位。
function assetFoliageLook(asset: SpeciesAsset): import('../tree/materials').SpeciesLook {
  return {
    leafColor: asset.seasonUniforms.uLeafColor.value as THREE.Color,
    flowerColor: asset.seasonUniforms.uFlowerColor.value as THREE.Color,
    foliageDensity: asset.seasonUniforms.uFoliageDensity.value as number,
    flowerAmount: asset.seasonUniforms.uFlowerAmount.value as number,
  };
}
