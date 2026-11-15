import * as THREE from 'three';
import type { ProjectData, SpacingIssue, TreeRecord, TreeSpecies, Zone, ZoneType } from './types';
import { BUILTIN_SPECIES } from './species';
import { defaultProject, loadProject, saveProject } from './storage';
import { checkSpacing, crownRadius, treeAge } from './growth';
import { Emitter } from './events';
import { hashInt32 } from './rng';

export type StoreEvent =
  | { kind: 'structure' }
  | { kind: 'matrix' }
  | { kind: 'lod' }
  | { kind: 'season' }
  | { kind: 'settings' }
  | { kind: 'zones' }
  | { kind: 'project' };

export class AppStore {
  data: ProjectData;
  readonly emitter = new Emitter<StoreEvent>();
  private nextTreeId = 1;
  private nextZoneId = 1;
  private nextSnapshotId = 1;
  private spacingIssues: SpacingIssue[] = [];
  private conflictIds = new Set<number>();
  selectedTreeId: number | null = null;

  constructor() {
    this.data = loadProject();
    this.reindexIds();
    this.runSpacing();
  }

  get species(): TreeSpecies[] {
    return [...BUILTIN_SPECIES, ...this.data.customSpecies];
  }

  get speciesMap(): Map<string, TreeSpecies> {
    const m = new Map<string, TreeSpecies>();
    for (const sp of this.species) m.set(sp.id, sp);
    return m;
  }

  getSpecies(id: string): TreeSpecies {
    return this.speciesMap.get(id)!;
  }

  private reindexIds(): void {
    for (const t of this.data.trees) this.nextTreeId = Math.max(this.nextTreeId, t.id + 1);
    for (const z of this.data.zones) this.nextZoneId = Math.max(this.nextZoneId, z.id + 1);
    for (const s of this.data.snapshots) this.nextSnapshotId = Math.max(this.nextSnapshotId, s.id + 1);
  }

  private autosave(): void {
    saveProject(this.data);
  }

  /* ---------------- 树木操作 ---------------- */

  /** 由坐标+全局种植序号派生确定性种子（同位置同序号 → 同树） */
  private deriveSeed(x: number, z: number): number {
    const seq = this.data.trees.length + this.nextTreeId * 31;
    return hashInt32(Math.round(x * 1000) ^ Math.round(z * 1000) ^ hashInt32(seq));
  }

  addTree(speciesId: string, x: number, z: number, plantedYear?: number): TreeRecord {
    const tree: TreeRecord = {
      id: this.nextTreeId++,
      speciesId,
      seed: this.deriveSeed(x, z),
      x,
      z,
      rotation: 0,
      plantedYear: plantedYear ?? this.data.settings.yearOffset,
    };
    this.data.trees.push(tree);
    this.afterStructureChange();
    return tree;
  }

  /** 阵列/片植：返回实际种下的树（空间不足的点位跳过） */
  addTrees(speciesId: string, points: { x: number; z: number }[]): TreeRecord[] {
    const added: TreeRecord[] = [];
    for (const p of points) {
      const tree = this.addTree(speciesId, p.x, p.z);
      added.push(tree);
    }
    return added;
  }

  moveTree(id: number, x: number, z: number): void {
    const t = this.data.trees.find((v) => v.id === id);
    if (!t) return;
    t.x = x;
    t.z = z;
    this.afterStructureChange();
  }

  rotateTree(id: number, rad: number): void {
    const t = this.data.trees.find((v) => v.id === id);
    if (!t) return;
    t.rotation = rad;
    this.emit({ kind: 'matrix' });
    this.autosave();
  }

  removeTree(id: number): void {
    this.data.trees = this.data.trees.filter((t) => t.id !== id);
    if (this.selectedTreeId === id) this.selectedTreeId = null;
    this.afterStructureChange();
  }

  clearTrees(): void {
    this.data.trees = [];
    this.selectedTreeId = null;
    this.afterStructureChange();
  }

  selectTree(id: number | null): void {
    this.selectedTreeId = id;
    this.emit({ kind: 'matrix' });
  }

  /** 预检查：在 (x,z) 种树是否会间距冲突，返回需要的间距与实际最小距离 */
  checkPlantPoint(speciesId: string, x: number, z: number, ignoreId?: number): { ok: boolean; minDist: number; required: number } {
    const sp = this.getSpecies(speciesId);
    const s = this.data.settings;
    const r0 = crownRadius(sp, 0, s.spacingByMature);
    let minDist = Infinity;
    let required = r0 * 2;
    for (const t of this.data.trees) {
      if (t.id === ignoreId) continue;
      const other = this.getSpecies(t.speciesId);
      const r1 = crownRadius(other, treeAge(t, s), s.spacingByMature);
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < minDist) {
        minDist = d;
        required = r0 + r1;
      }
    }
    return { ok: minDist >= required, minDist, required };
  }

  /** 点位是否落在禁止种树的分区（道路/水面/铺装） */
  zoneAt(x: number, z: number): Zone | null {
    for (const zone of this.data.zones) {
      if (zone.type === 'lawn') continue;
      if (pointInPolygon(x, z, zone.points)) return zone;
    }
    return null;
  }

  private afterStructureChange(): void {
    this.runSpacing();
    this.autosave();
    this.emit({ kind: 'structure' });
  }

  runSpacing(): void {
    this.spacingIssues = checkSpacing(this.data.trees, this.speciesMap, this.data.settings);
    this.conflictIds = new Set();
    for (const it of this.spacingIssues) {
      this.conflictIds.add(it.treeId);
      this.conflictIds.add(it.otherId);
    }
  }

  get issues(): SpacingIssue[] {
    return this.spacingIssues;
  }

  get conflicts(): Set<number> {
    return this.conflictIds;
  }

  /* ---------------- 分区 ---------------- */

  addZone(type: ZoneType, points: { x: number; z: number }[], name?: string): Zone {
    const labels: Record<ZoneType, string> = { lawn: '草坪', road: '道路', water: '水面', paving: '铺装' };
    const zone: Zone = {
      id: this.nextZoneId++,
      type,
      name: name ?? `${labels[type]}${this.nextZoneId - 1}`,
      points: points.map((p) => ({ ...p })),
    };
    this.data.zones.push(zone);
    this.autosave();
    this.emit({ kind: 'zones' });
    return zone;
  }

  removeZone(id: number): void {
    this.data.zones = this.data.zones.filter((z) => z.id !== id);
    this.autosave();
    this.emit({ kind: 'zones' });
  }

  /* ---------------- 设置 / 季节 / 生长 ---------------- */

  updateSettings(patch: Partial<ProjectData['settings']>): void {
    const prev = this.data.settings;
    Object.assign(prev, patch);
    this.autosave();
    if ('yearOffset' in patch) {
      this.runSpacing();
      this.emit({ kind: 'matrix' });
    } else if ('seasonT' in patch) {
      this.emit({ kind: 'season' });
    } else if ('quality' in patch || 'shadow' in patch) {
      this.emit({ kind: 'settings' });
    } else {
      this.emit({ kind: 'settings' });
    }
  }

  resetSeasonUniformsFlag(): void {
    /* 季节事件由页面侧监听后更新材质 uniform */
  }

  /* ---------------- 自定义树种 ---------------- */

  addCustomSpecies(sp: TreeSpecies): void {
    sp.custom = true;
    this.data.customSpecies.push(sp);
    this.autosave();
    this.emit({ kind: 'project' });
  }

  /* ---------------- 项目级 ---------------- */

  replaceProject(next: ProjectData): void {
    this.data = next;
    this.nextTreeId = 1;
    this.nextZoneId = 1;
    this.nextSnapshotId = 1;
    this.reindexIds();
    this.selectedTreeId = null;
    this.runSpacing();
    this.emit({ kind: 'project' });
    this.autosave();
  }

  resetProject(): void {
    this.replaceProject(defaultProject());
  }

  addSnapshot(name: string, dataUrl: string): void {
    this.data.snapshots.unshift({
      id: this.nextSnapshotId++,
      name,
      dataUrl,
      date: new Date().toLocaleString('zh-CN'),
    });
    if (this.data.snapshots.length > 12) this.data.snapshots.length = 12;
    this.autosave();
    this.emit({ kind: 'project' });
  }

  removeSnapshot(id: number): void {
    this.data.snapshots = this.data.snapshots.filter((s) => s.id !== id);
    this.autosave();
    this.emit({ kind: 'project' });
  }

  /* ---------------- 苗木清单统计 ---------------- */

  inventory(): { species: TreeSpecies; count: number; matureHeight: number; crownWidth: number; subtotal: number }[] {
    const counter = new Map<string, number>();
    for (const t of this.data.trees) counter.set(t.speciesId, (counter.get(t.speciesId) ?? 0) + 1);
    return [...counter.entries()]
      .map(([id, count]) => {
        const sp = this.getSpecies(id);
        return { species: sp, count, matureHeight: sp.matureHeight, crownWidth: sp.crownWidth, subtotal: count * sp.cost };
      })
      .sort((a, b) => b.count - a.count);
  }

  totalCost(): number {
    return this.inventory().reduce((sum, it) => sum + it.subtotal, 0);
  }

  private emit(e: StoreEvent): void {
    this.emitter.emit(e);
  }
}

/** 射线与平面交点等场景辅助使用的共享临时向量 */
export const _v3 = new THREE.Vector3();

/** 点在多边形内（射线法，XZ 平面） */
export function pointInPolygon(x: number, z: number, poly: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
