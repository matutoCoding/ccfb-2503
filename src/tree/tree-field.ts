import * as THREE from 'three';
import type { ProjectData, QualityLevel, TreeRecord, TreeSpecies } from '../core/types';
import { treeAge, treeHeight } from '../core/growth';
import { getCachedAsset, type SpeciesAsset } from './model-library';
import { VARIANT_COUNT } from './generator';

/** 各画质的 LOD 距离（米）与阴影上限 */
const LOD_RANGES: Record<QualityLevel, { high: number; low: number; shadowMax: number }> = {
  high: { high: 28, low: 70, shadowMax: 1200 },
  medium: { high: 12, low: 42, shadowMax: 600 },
  low: { high: 7, low: 25, shadowMax: 200 },
};

/** LOD 滞回带（米）：越过边界后要再移动该距离才会切换，抑制抖动 */
const HYSTERESIS = 3;

interface MeshBucket {
  mesh: THREE.InstancedMesh;
  treeIds: number[];
  capacity: number;
}

interface GroupBucket {
  branch: MeshBucket;
  foliage: MeshBucket;
  capacity: number;
}

interface BillboardBucket {
  mesh: THREE.InstancedMesh;
  treeIds: number[];
  capacity: number;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();

function nextCap(n: number): number {
  let c = 32;
  while (c < n) c *= 2;
  return c;
}

/**
 * 树木实例场：
 * - 按 (树种 × 变体 × LOD × 部件) 分桶 InstancedMesh
 * - 每帧按相机距离重新分级，远处自动换公告板
 * - 全场共享 1 个不可见拾取代理，raycast 返回 treeId
 */
export class TreeField {
  private groups = new Map<string, GroupBucket>(); // key: species:variant:lod
  private boards = new Map<string, BillboardBucket>(); // key: species
  private proxy!: THREE.InstancedMesh;
  private proxyIds: number[] = [];
  private proxyDirty = true;
  private lodDirty = true;
  private matrixDirty = true;
  private conflictIds = new Set<number>();
  private selectedId: number | null = null;
  private lastLodPos = new THREE.Vector3(1e9, 0, 1e9);
  private frameSkip = 0;
  /** 每棵树当前 LOD：0=高模 1=低模 2=公告板 */
  private treeLod = new Map<number, 0 | 1 | 2>();
  readonly group = new THREE.Group();

  constructor(
    private getProject: () => ProjectData,
    private speciesMap: Map<string, TreeSpecies>,
  ) {
    this.buildProxy(64);
  }

  /* ---------------- 拾取代理 ---------------- */

  private buildProxy(capacity: number): void {
    if (this.proxy) {
      this.group.remove(this.proxy);
      this.proxy.geometry.dispose();
      (this.proxy.material as THREE.Material).dispose();
    }
    const geo = new THREE.SphereGeometry(1, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    this.proxy = new THREE.InstancedMesh(geo, mat, capacity);
    this.proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.proxy.frustumCulled = false;
    this.proxy.userData.isTreeProxy = true;
    this.group.add(this.proxy);
  }

  /** raycast 命中 → treeId（未命中 null） */
  pick(raycaster: THREE.Raycaster): number | null {
    const hits = raycaster.intersectObject(this.proxy, false);
    if (!hits.length) return null;
    const instanceId = hits[0].instanceId;
    if (instanceId == null) return null;
    return this.proxyIds[instanceId] ?? null;
  }

  /* ---------------- 桶管理 ---------------- */

  private groupKey(sp: string, variant: number, lod: number): string {
    return `${sp}:${variant}:${lod}`;
  }

  private ensureGroup(asset: SpeciesAsset, variant: number, lod: 0 | 1, need: number): GroupBucket {
    const key = this.groupKey(asset.species.id, variant, lod);
    const existing = this.groups.get(key);
    if (existing && existing.capacity >= need) return existing;

    if (existing) this.disposeGroup(existing);
    const model = asset.models[variant];
    const geoSet = lod === 0 ? model.lodHigh : model.lodLow;
    const cap = nextCap(need);
    const makeMesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      const colors = new Float32Array(cap * 3).fill(1);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      this.group.add(mesh);
      return mesh;
    };
    const bucket: GroupBucket = {
      branch: { mesh: makeMesh(geoSet.branch, asset.branchMat), treeIds: [], capacity: cap },
      foliage: { mesh: makeMesh(geoSet.foliage, asset.foliageMat), treeIds: [], capacity: cap },
      capacity: cap,
    };
    this.groups.set(key, bucket);
    return bucket;
  }

  private ensureBoard(asset: SpeciesAsset, need: number): BillboardBucket {
    const key = asset.species.id;
    const existing = this.boards.get(key);
    if (existing && existing.capacity >= need) return existing;
    if (existing) {
      this.group.remove(existing.mesh);
      existing.mesh.geometry.dispose();
    }
    const cap = nextCap(need);
    // 单位平面（y∈[0,1]），公告板着色器按实例矩阵缩放与朝向
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, asset.billboardMat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    const colors = new Float32Array(cap * 3).fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    // 每实例的变体图块横向偏移（0, 0.25, 0.5, 0.75）
    const variantAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    geo.setAttribute('aVariant', variantAttr);
    this.group.add(mesh);
    const bucket: BillboardBucket = { mesh, treeIds: [], capacity: cap };
    this.boards.set(key, bucket);
    return bucket;
  }

  private disposeGroup(b: GroupBucket): void {
    this.group.remove(b.branch.mesh, b.foliage.mesh);
    b.branch.mesh.geometry.dispose();
    b.foliage.mesh.geometry.dispose();
  }

  /* ---------------- 对外失效信号 ---------------- */

  markStructural(): void {
    this.lodDirty = true;
    this.matrixDirty = true;
    this.proxyDirty = true;
    this.treeLod.clear();
  }

  markMatrix(): void {
    this.matrixDirty = true;
    this.proxyDirty = true;
  }

  markLod(): void {
    this.lodDirty = true;
  }

  setConflicts(ids: Set<number>): void {
    this.conflictIds = ids;
    this.matrixDirty = true; // 颜色随矩阵刷新一起写
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
    this.matrixDirty = true;
  }

  /* ---------------- 变体与矩阵 ---------------- */

  private variantOf(tree: TreeRecord): number {
    return tree.seed % VARIANT_COUNT;
  }

  private writeMatrix(mesh: THREE.InstancedMesh, slot: number, tree: TreeRecord, sp: TreeSpecies, asset: SpeciesAsset): void {
    const age = treeAge(tree, this.getProject().settings);
    const h = treeHeight(sp, age);
    const jitter = asset.jitterFor(tree.seed);
    const isBoard = mesh.geometry.getAttribute('aVariant') !== undefined;
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.rotation);
    _pos.set(tree.x, 0, tree.z);
    if (isBoard) {
      // 公告板：高=树高，宽按单位冠幅半径折算
      const width = h * asset.models[0].unitCrownRadius * 2 * jitter;
      _scale.set(width, h, 1);
    } else {
      const s = h * jitter;
      _scale.set(s, s, s);
    }
    _m4.compose(_pos, _q, _scale);
    mesh.setMatrixAt(slot, _m4);
  }

  private writeColor(mesh: THREE.InstancedMesh, slot: number, tree: TreeRecord): void {
    if (this.conflictIds.has(tree.id)) _color.setRGB(1.0, 0.45, 0.4);
    else if (this.selectedId === tree.id) _color.setRGB(0.55, 0.8, 1.0);
    else _color.setRGB(1, 1, 1);
    mesh.setColorAt(slot, _color);
  }

  /* ---------------- 每帧更新 ---------------- */

  update(camera: THREE.Camera, quality: QualityLevel): void {
    const project = this.getProject();
    if (this.proxyDirty) this.rebuildProxy(project);
    if (this.matrixDirty) this.rebuildMatrices(project);
    // 相机移动超过阈值（或每 45 帧兜底）时重新分级；assignLod 内部会再判断级别是否真的变化
    this.frameSkip++;
    const movedSq = camera.position.distanceToSquared(this.lastLodPos);
    const threshold = quality === 'high' ? 64 : quality === 'medium' ? 25 : 9;
    if (this.lodDirty || this.proxyDirty || movedSq > threshold || this.frameSkip >= 45) {
      this.assignLod(camera, quality);
      this.lastLodPos.copy(camera.position);
      this.frameSkip = 0;
    }
    this.lodDirty = false;
    this.matrixDirty = false;
    this.proxyDirty = false;
  }

  private rebuildProxy(project: ProjectData): void {
    const trees = project.trees;
    if (this.proxy.count < trees.length && this.proxy.instanceMatrix.count < trees.length) {
      this.buildProxy(nextCap(trees.length));
    }
    this.proxyIds = [];
    trees.forEach((tree, i) => {
      const sp = this.speciesMap.get(tree.speciesId);
      if (!sp) return;
      const asset = getCachedAsset(sp.id);
      if (!asset) return;
      const age = treeAge(tree, project.settings);
      const h = treeHeight(sp, age);
      const r = h * asset.models[0].unitCrownRadius;
      _q.identity();
      _pos.set(tree.x, h * 0.55, tree.z);
      _scale.set(r * 0.85, h * 0.6, r * 0.85);
      _m4.compose(_pos, _q, _scale);
      this.proxy.setMatrixAt(i, _m4);
      this.proxyIds.push(tree.id);
    });
    this.proxy.count = trees.length;
    this.proxy.instanceMatrix.needsUpdate = true;
  }

  private rebuildMatrices(project: ProjectData): void {
    for (const tree of project.trees) {
      const sp = this.speciesMap.get(tree.speciesId);
      if (!sp) continue;
      const asset = getCachedAsset(sp.id);
      if (!asset) continue;
      const v = this.variantOf(tree);
      for (const lod of [0, 1] as const) {
        const bucket = this.groups.get(this.groupKey(sp.id, v, lod));
        if (!bucket) continue;
        const slot = bucket.branch.treeIds.indexOf(tree.id);
        if (slot < 0) continue;
        this.writeMatrix(bucket.branch.mesh, slot, tree, sp, asset);
        this.writeMatrix(bucket.foliage.mesh, slot, tree, sp, asset);
        this.writeColor(bucket.branch.mesh, slot, tree);
        this.writeColor(bucket.foliage.mesh, slot, tree);
        bucket.branch.mesh.instanceMatrix.needsUpdate = true;
        bucket.foliage.mesh.instanceMatrix.needsUpdate = true;
        if (bucket.branch.mesh.instanceColor) bucket.branch.mesh.instanceColor.needsUpdate = true;
        if (bucket.foliage.mesh.instanceColor) bucket.foliage.mesh.instanceColor.needsUpdate = true;
      }
      const board = this.boards.get(sp.id);
      if (board) {
        const slot = board.treeIds.indexOf(tree.id);
        if (slot >= 0) {
          this.writeMatrix(board.mesh, slot, tree, sp, asset);
          this.writeColor(board.mesh, slot, tree);
          board.mesh.instanceMatrix.needsUpdate = true;
          if (board.mesh.instanceColor) board.mesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  /** 按相机距离把每棵树分到 high / low / billboard 桶 */
  private assignLod(camera: THREE.Camera, quality: QualityLevel): void {
    const project = this.getProject();
    const ranges = LOD_RANGES[quality];
    const cam = camera.position;

    // 统计需求，按需扩容
    const need = new Map<string, number>();
    const boardNeed = new Map<string, number>();
    const assignment = new Map<number, { key: string | null; board: string | null }>();
    let anyChanged = false;

    for (const tree of project.trees) {
      const sp = this.speciesMap.get(tree.speciesId);
      if (!sp || !getCachedAsset(sp.id)) continue;
      const d = Math.hypot(tree.x - cam.x, tree.z - cam.z);
      const variant = this.variantOf(tree);
      // 滞回：升级（更精细）要越过内边界，降级（更粗糙）要越过外边界
      const prev = this.treeLod.get(tree.id) ?? 1;
      let target: 0 | 1 | 2;
      if (d >= ranges.low + HYSTERESIS) target = 2;
      else if (d <= ranges.high - HYSTERESIS) target = 0;
      else if (d >= ranges.low) target = prev === 2 ? 2 : 1;
      else if (d <= ranges.high) target = prev === 0 ? 0 : 1;
      else target = prev;
      if (target !== prev) anyChanged = true;
      this.treeLod.set(tree.id, target);
      if (target === 2) {
        boardNeed.set(sp.id, (boardNeed.get(sp.id) ?? 0) + 1);
        assignment.set(tree.id, { key: null, board: sp.id });
      } else {
        const lod = target;
        const key = this.groupKey(sp.id, variant, lod);
        need.set(key, (need.get(key) ?? 0) + 1);
        assignment.set(tree.id, { key, board: null });
      }
    }

    // 没有任何树改变 LOD 级别时，跳过重填桶（相机静止/阻尼微动的热路径）
    if (!anyChanged && !this.lodDirty && !this.proxyDirty) return;

    // 扩容/创建桶
    for (const [key, n] of need) {
      const [speciesId, vStr, lodStr] = key.split(':');
      const asset = getCachedAsset(speciesId)!;
      this.ensureGroup(asset, Number(vStr), Number(lodStr) as 0 | 1, n);
    }
    for (const [speciesId, n] of boardNeed) {
      this.ensureBoard(getCachedAsset(speciesId)!, n);
    }

    // 清空所有桶槽位
    this.groups.forEach((b) => {
      b.branch.treeIds.length = 0;
      b.foliage.treeIds.length = 0;
      b.branch.mesh.count = 0;
      b.foliage.mesh.count = 0;
    });
    this.boards.forEach((b) => {
      b.treeIds.length = 0;
      b.mesh.count = 0;
    });

    // 填槽
    for (const tree of project.trees) {
      const a = assignment.get(tree.id);
      if (!a) continue;
      const sp = this.speciesMap.get(tree.speciesId)!;
      const asset = getCachedAsset(sp.id)!;
      if (a.key) {
        const bucket = this.groups.get(a.key)!;
        const slot = bucket.branch.treeIds.length;
        bucket.branch.treeIds.push(tree.id);
        bucket.foliage.treeIds.push(tree.id);
        this.writeMatrix(bucket.branch.mesh, slot, tree, sp, asset);
        this.writeMatrix(bucket.foliage.mesh, slot, tree, sp, asset);
        this.writeColor(bucket.branch.mesh, slot, tree);
        this.writeColor(bucket.foliage.mesh, slot, tree);
        bucket.branch.mesh.count = slot + 1;
        bucket.foliage.mesh.count = slot + 1;
      } else if (a.board) {
        const board = this.boards.get(a.board)!;
        const slot = board.treeIds.length;
        this.writeMatrix(board.mesh, slot, tree, sp, asset);
        this.writeColor(board.mesh, slot, tree);
        const attr = board.mesh.geometry.getAttribute('aVariant') as THREE.InstancedBufferAttribute;
        attr.setX(slot, this.variantOf(tree) / VARIANT_COUNT);        board.treeIds.push(tree.id);
        board.mesh.count = slot + 1;
      }
    }

    this.groups.forEach((b) => {
      b.branch.mesh.instanceMatrix.needsUpdate = true;
      b.foliage.mesh.instanceMatrix.needsUpdate = true;
      if (b.branch.mesh.instanceColor) b.branch.mesh.instanceColor.needsUpdate = true;
      if (b.foliage.mesh.instanceColor) b.foliage.mesh.instanceColor.needsUpdate = true;
    });
    this.boards.forEach((b) => {
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      const attr = b.mesh.geometry.getAttribute('aVariant') as THREE.InstancedBufferAttribute;
      attr.needsUpdate = true;
    });

    // 阴影：低画质只给近景高模投影
    this.applyShadowLimits(ranges.shadowMax);
  }

  private applyShadowLimits(maxTrees: number): void {
    let shadowed = 0;
    this.groups.forEach((b, key) => {
      const lod = Number(key.split(':')[2]);
      const on = lod === 0 && shadowed < maxTrees;
      shadowed += b.branch.mesh.count;
      b.branch.mesh.castShadow = on;
      b.foliage.mesh.castShadow = on;
    });
  }

  /** 当前实例总 draw call 估算（调试/汇报页性能指标用） */
  drawCallCount(): number {
    let n = 0;
    this.groups.forEach((b) => {
      if (b.branch.mesh.count > 0) n += 2;
    });
    this.boards.forEach((b) => {
      if (b.mesh.count > 0) n += 1;
    });
    return n;
  }

  dispose(): void {
    this.groups.forEach((b) => this.disposeGroup(b));
    this.groups.clear();
    this.boards.forEach((b) => {
      this.group.remove(b.mesh);
      b.mesh.geometry.dispose();
    });
    this.boards.clear();
    this.group.remove(this.proxy);
    this.proxy.geometry.dispose();
    (this.proxy.material as THREE.Material).dispose();
  }
}
