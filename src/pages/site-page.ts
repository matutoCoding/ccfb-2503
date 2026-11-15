import * as THREE from 'three';
import type { Page, PageContext } from './page';
import { h, section, sliderRow, selectRow, toast, confirmDialog } from '../ui/dom';
import { createView, type ViewHandle } from './shared-view';
import { getCachedAsset } from '../tree/model-library';
import type { TreeRecord, ZoneType } from '../core/types';
import type { TreeSpecies } from '../core/types';

type Mode = 'plant' | 'brush' | 'zone' | 'select';

export class SitePage implements Page {
  id = 'site';
  title = '场地编辑';
  private root: HTMLElement | null = null;
  private view!: ViewHandle;
  private ctx!: PageContext;
  private mode: Mode = 'plant';
  private activeSpecies: TreeSpecies | null = null;
  private zoneType: ZoneType = 'lawn';
  private drawingPoints: { x: number; z: number }[] = [];
  private previewLine: THREE.Line | null = null;
  private ghost: THREE.Group | null = null;
  private brushRadius = 8;
  private brushSpacing = 0; // 0 = 按当前冠幅自动
  private brushCircle: THREE.Mesh | null = null;
  private statusEl!: HTMLElement;
  private markerRing: THREE.Mesh | null = null;
  private offs: (() => void)[] = [];

  mount(ctx: PageContext): void {
    this.ctx = ctx;
    const viewport = h('div', { className: 'viewport' });
    this.view = createView(viewport, ctx.store);
    this.statusEl = h('div', { className: 'status-bar' });
    viewport.append(this.statusEl, this.buildDropHint());

    const side = this.buildSidebar();
    this.root = h('div', { className: 'page' }, [side, viewport]);
    ctx.mount.appendChild(this.root);

    this.view.ensureSpecies(ctx.store.species).then(() => this.refreshGhost());
    this.bindSceneEvents();
    this.applyMode();

    // 从苗木库卡片跳转携带的树种
    const preset = sessionStorage.getItem('plant-species');
    if (preset) {
      const sp = ctx.store.speciesMap.get(preset);
      if (sp) this.selectSpecies(sp);
      sessionStorage.removeItem('plant-species');
    } else if (!this.activeSpecies) {
      this.activeSpecies = ctx.store.species[0];
      this.refreshGhost();
    }
    this.refreshStatus();
  }

  /* ---------------- 侧栏 ---------------- */

  private buildSidebar(): HTMLElement {
    const speciesOptions = this.ctx.store.species.map((sp) => ({ value: sp.id, text: `${sp.name}（${sp.category}）` }));
    const speciesSel = h('select', {}, speciesOptions.map((o) =>
      h('option', { value: o.value, textContent: o.text, selected: this.activeSpecies?.id === o.value }),
    )) as HTMLSelectElement;
    speciesSel.addEventListener('change', () => {
      const sp = this.ctx.store.speciesMap.get(speciesSel.value);
      if (sp) this.selectSpecies(sp);
    });

    const modeBtns = [
      { m: 'plant' as Mode, label: '单株种植' },
      { m: 'brush' as Mode, label: '片植刷' },
      { m: 'zone' as Mode, label: '分区绘制' },
      { m: 'select' as Mode, label: '选择/移动' },
    ].map(({ m, label }) => h('button', {
      textContent: label,
      onclick: () => { this.mode = m; this.applyMode(); },
      dataset: { mode: m },
    }));

    const zoneSel = selectRow('分区类型', [
      { value: 'lawn', text: '草坪（可种树）' },
      { value: 'road', text: '道路（禁种）' },
      { value: 'water', text: '水面（禁种）' },
      { value: 'paving', text: '铺装（禁种）' },
    ], this.zoneType, (v) => { this.zoneType = v as ZoneType; });

    const zoneList = h('div', { className: 'stack' });
    const renderZones = (): void => {
      zoneList.innerHTML = '';
      if (!this.ctx.store.data.zones.length) {
        zoneList.appendChild(h('p', { className: 'muted' }, ['尚未绘制分区']));
        return;
      }
      for (const z of this.ctx.store.data.zones) {
        zoneList.appendChild(h('div', { className: 'field' }, [
          h('span', { textContent: `${z.name}（${z.points.length}点）` }),
          h('button', { className: 'small danger', textContent: '删', onclick: () => this.ctx.store.removeZone(z.id) }),
        ]));
      }
    };
    renderZones();
    this.offs.push(this.ctx.store.emitter.on((e) => { if (e.kind === 'zones') renderZones(); }));

    const treeInfo = h('div', { className: 'stack' });
    const renderTreeInfo = (): void => {
      treeInfo.innerHTML = '';
      const count = this.ctx.store.data.trees.length;
      treeInfo.appendChild(h('p', { className: 'muted' }, [
        `场地内共 ${count} 株树，间距冲突 ${this.ctx.store.issues.length} 处。`,
      ]));
      const sel = this.ctx.store.data.trees.find((t) => t.id === this.ctx.store.selectedTreeId);
      if (sel) {
        const sp = this.ctx.store.getSpecies(sel.speciesId);
        treeInfo.appendChild(h('div', { className: 'panel-section' }, [
          h('h3', {}, [`已选：${sp.name}`]),
          h('div', { className: 'spec-line' }, [h('span', {}, ['坐标']), h('b', {}, [`(${sel.x.toFixed(1)}, ${sel.z.toFixed(1)})`])]),
          h('div', { className: 'spec-line' }, [h('span', {}, ['种子']), h('b', {}, [String(sel.seed)])]),
          h('div', { className: 'row', style: 'margin-top:8px' }, [
            h('button', { className: 'small', textContent: '旋转 90°', onclick: () => this.ctx.store.rotateTree(sel.id, sel.rotation + Math.PI / 2) }),
            h('button', { className: 'small danger', textContent: '删除', onclick: () => this.ctx.store.removeTree(sel.id) }),
          ]),
        ]));
      }
    };
    renderTreeInfo();
    this.offs.push(this.ctx.store.emitter.on((e) => {
      if (e.kind === 'structure' || e.kind === 'matrix') renderTreeInfo();
    }));

    return h('div', { className: 'sidebar wide' }, [
      section('工具', h('div', { className: 'seg-group', style: 'flex-wrap:wrap' }, modeBtns)),
      section('树种', speciesSel),
      section('片植刷参数',
        sliderRow('刷半径 m', this.brushRadius, 3, 25, 0.5, (v) => { this.brushRadius = v; this.updateBrushCircle(); }),
        h('p', { className: 'muted' }, ['按当前树冠间距自动布点，松开鼠标成片种植；红圈表示空间不足点位会跳过。']),
      ),
      section('分区', zoneSel,
        h('p', { className: 'muted' }, ['在地面依次点击描点，双击或按 Enter 闭合；道路/水面/铺装内禁止种树。']),
        h('div', { className: 'row' }, [
          h('button', { className: 'small danger', textContent: '撤销上一点', onclick: () => this.undoPoint() }),
          h('button', { className: 'small', textContent: '闭合多边形', onclick: () => this.closeZone() }),
        ]),
        zoneList,
      ),
      section('苗木', treeInfo),
      section('场地',
        h('div', { className: 'stack' }, [
          h('button', { className: 'danger', textContent: '清空全部树木', onclick: () => confirmDialog('确定清空场地内所有树木？', () => { this.ctx.store.clearTrees(); toast('已清空'); }) }),
        ]),
      ),
    ]);
  }

  private buildDropHint(): HTMLElement {
    const el = h('div', { className: 'drop-hint' }, ['松开鼠标，在此处种植']);
    return el;
  }

  /* ---------------- 模式切换 ---------------- */

  private applyMode(): void {
    this.root?.querySelectorAll('[data-mode]').forEach((b) => {
      (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.mode === this.mode);
    });
    this.clearDrawing();
    this.setGhostVisible(this.mode === 'plant' || this.mode === 'brush');
    this.setBrushVisible(this.mode === 'brush');
    this.view.scene.controls.enabled = this.mode !== 'zone';
    this.refreshStatus();
  }

  private selectSpecies(sp: TreeSpecies): void {
    this.activeSpecies = sp;
    this.refreshGhost();
  }

  /* ---------------- 幽灵预览树 ---------------- */

  private refreshGhost(): void {
    if (this.ghost) {
      this.view.scene.scene.remove(this.ghost);
      (this.ghost.userData.ghostMats as THREE.Material[] | undefined)?.forEach((m) => m.dispose());
      this.ghost = null;
    }
    if (!this.activeSpecies) return;
    // 借用已生成模型的低模（材质独立克隆，避免污染实例共享材质）
    const sp = this.activeSpecies;
    const build = (): void => {
      const asset = getCachedAsset(sp.id);
      if (!asset) {
        this.view.ensureSpecies([sp]).then(build);
        return;
      }
      const model = asset.models[0];
      this.ghost = new THREE.Group();
      const ghostBranchMat = asset.branchMat.clone();
      const ghostFoliageMat = asset.foliageMat.clone();
      for (const m of [ghostBranchMat, ghostFoliageMat]) {
        m.transparent = true;
        m.opacity = 0.72;
      }
      const branch = new THREE.Mesh(model.lodLow.branch, ghostBranchMat);
      const foliage = new THREE.Mesh(model.lodLow.foliage, ghostFoliageMat);
      this.ghost.userData.ghostMats = [ghostBranchMat, ghostFoliageMat];
      this.ghost.add(branch, foliage);
      this.ghost.scale.setScalar(sp.saplingHeight);
      this.ghost.visible = this.mode === 'plant' || this.mode === 'brush';
      this.view.scene.scene.add(this.ghost);
    };
    build();
  }

  private setGhostVisible(v: boolean): void {
    if (this.ghost) this.ghost.visible = v;
  }

  /* ---------------- 片植刷圆圈 ---------------- */

  private ensureBrushCircle(): void {
    if (this.brushCircle) return;
    const geo = new THREE.RingGeometry(0.98, 1, 64);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x7cb342, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    this.brushCircle = new THREE.Mesh(geo, mat);
    this.brushCircle.position.y = 0.08;
    this.brushCircle.visible = false;
    this.view.scene.scene.add(this.brushCircle);
  }

  private updateBrushCircle(): void {
    if (!this.brushCircle) return;
    this.brushCircle.scale.setScalar(this.brushRadius);
  }

  private setBrushVisible(v: boolean): void {
    this.ensureBrushCircle();
    this.updateBrushCircle();
    this.brushCircle!.visible = v;
  }

  /* ---------------- 场景交互 ---------------- */

  private bindSceneEvents(): void {
    const dom = this.view.scene.renderer.domElement;
    const groundPoint = new THREE.Vector3();

    const move = (e: PointerEvent): void => {
      if (!this.view.scene.screenToGround(e.clientX, e.clientY, groundPoint)) return;
      const size = this.ctx.store.data.settings.siteSize;
      const x = THREE.MathUtils.clamp(groundPoint.x, -size / 2, size / 2);
      const z = THREE.MathUtils.clamp(groundPoint.z, -size / 2, size / 2);

      if (this.ghost && (this.mode === 'plant' || this.mode === 'brush')) {
        this.ghost.position.set(x, 0, z);
        const sp = this.activeSpecies!;
        const check = this.ctx.store.checkPlantPoint(sp.id, x, z);
        const blocked = !!this.ctx.store.zoneAt(x, z);
        this.ghost.scale.setScalar(sp.saplingHeight);
        const tint = blocked || !check.ok ? 0xd96656 : 0x8bc34a;
        // 半透明高亮：只影响幽灵树的克隆材质
        this.ghost.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            const m = o.material as THREE.MeshStandardMaterial;
            m.emissive.setHex(tint);
            m.emissiveIntensity = 0.45;
          }
        });
      }
      if (this.brushCircle && this.mode === 'brush') {
        this.brushCircle.position.set(x, 0.08, z);
      }
      if (this.mode === 'zone') {
        this.updatePreviewLine(x, z);
      }
    };

    const click = (e: PointerEvent): void => {
      if (!this.view.scene.screenToGround(e.clientX, e.clientY, groundPoint)) return;
      const size = this.ctx.store.data.settings.siteSize;
      const x = THREE.MathUtils.clamp(groundPoint.x, -size / 2, size / 2);
      const z = THREE.MathUtils.clamp(groundPoint.z, -size / 2, size / 2);
      if (this.mode === 'plant') this.plantOne(x, z);
      else if (this.mode === 'zone') this.addPoint(x, z);
    };

    const dblClick = (): void => {
      if (this.mode === 'zone') this.closeZone();
    };

    const key = (e: KeyboardEvent): void => {
      if (this.mode === 'zone' && e.key === 'Enter') this.closeZone();
      if (this.mode === 'zone' && e.key === 'Escape') this.clearDrawing();
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx.store.selectedTreeId != null) {
        const id = this.ctx.store.selectedTreeId;
        this.ctx.store.removeTree(id);
        this.hideMarker();
      }
    };

    let brushing = false;
    const brushDown = (e: PointerEvent): void => {
      if (this.mode !== 'brush') return;
      brushing = true;
      if (this.view.scene.screenToGround(e.clientX, e.clientY, groundPoint)) {
        this.applyBrush(groundPoint.x, groundPoint.z);
      }
    };
    const brushMove = (e: PointerEvent): void => {
      if (!brushing || this.mode !== 'brush') return;
      if (this.view.scene.screenToGround(e.clientX, e.clientY, groundPoint)) {
        this.applyBrush(groundPoint.x, groundPoint.z);
      }
    };
    const brushUp = (): void => { brushing = false; };

    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', click);
    dom.addEventListener('dblclick', dblClick);
    dom.addEventListener('pointerdown', brushDown);
    dom.addEventListener('pointermove', brushMove);
    window.addEventListener('pointerup', brushUp);
    window.addEventListener('keydown', key);
    this.offs.push(() => {
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', click);
      dom.removeEventListener('dblclick', dblClick);
      dom.removeEventListener('pointerdown', brushDown);
      dom.removeEventListener('pointermove', brushMove);
      window.removeEventListener('pointerup', brushUp);
      window.removeEventListener('keydown', key);
    });

    // 拖放（来自苗木库卡片）
    const hint = this.root!.querySelector('.drop-hint') as HTMLElement;
    dom.addEventListener('dragover', (e) => {
      e.preventDefault();
      hint.classList.add('show');
    });
    dom.addEventListener('dragleave', (e) => {
      if (e.target === dom) hint.classList.remove('show');
    });
    dom.addEventListener('drop', (e) => {
      e.preventDefault();
      hint.classList.remove('show');
      const speciesId = e.dataTransfer?.getData('application/x-species');
      if (!speciesId) return;
      const sp = this.ctx.store.speciesMap.get(speciesId);
      if (!sp) return;
      this.selectSpecies(sp);
      if (this.view.scene.screenToGround(e.clientX, e.clientY, groundPoint)) {
        this.mode = 'plant';
        this.applyMode();
        this.plantOne(groundPoint.x, groundPoint.z);
      }
    });

    // 拾取选择（仅选择模式）
    this.view.onPick((id) => {
      if (this.mode !== 'select') return;
      this.ctx.store.selectTree(id);
      if (id != null) this.showMarker(id);
      else this.hideMarker();
    });
  }

  private plantOne(x: number, z: number): void {
    const sp = this.activeSpecies;
    if (!sp) { toast('请先选择树种', 'warn'); return; }
    const blocked = this.ctx.store.zoneAt(x, z);
    if (blocked) {
      this.flashStatus(`⚠ 该位置位于${blocked.name}内，禁止种植`, 'danger');
      return;
    }
    const check = this.ctx.store.checkPlantPoint(sp.id, x, z);
    if (!check.ok) {
      this.flashStatus(`⚠ 间距不足：需 ${check.required.toFixed(1)}m，当前最近 ${check.minDist.toFixed(1)}m`, 'danger');
      // 仍允许强制种下，但标记冲突（设计决策留给设计师）
    }
    this.ctx.store.addTree(sp.id, x, z);
    this.refreshStatus();
  }

  /** 片植刷：蜂窝布点 + 逐点间距/分区检查 */
  private applyBrush(cx: number, cz: number): void {
    const sp = this.activeSpecies;
    if (!sp) return;
    const s = this.ctx.store.data.settings;
    const spacing = this.brushSpacing > 0
      ? this.brushSpacing
      : sp.crownWidth * (s.spacingByMature ? 1 : 0.28);
    const step = spacing * 0.95;
    const rows = Math.ceil(this.brushRadius / (step * 0.866));
    const points: { x: number; z: number }[] = [];
    for (let r = -rows; r <= rows; r++) {
      const z = cz + r * step * 0.866;
      const offset = (r & 1) ? step * 0.5 : 0;
      for (let c = -rows; c <= rows; c++) {
        const x = cx + c * step + offset;
        if (Math.hypot(x - cx, z - cz) > this.brushRadius) continue;
        points.push({ x, z });
      }
    }
    let planted = 0;
    let skipped = 0;
    for (const p of points) {
      if (this.ctx.store.zoneAt(p.x, p.z)) { skipped++; continue; }
      const check = this.ctx.store.checkPlantPoint(sp.id, p.x, p.z);
      if (!check.ok) { skipped++; continue; }
      this.ctx.store.addTree(sp.id, p.x, p.z);
      planted++;
    }
    if (planted) this.flashStatus(`片植 ${planted} 株${skipped ? `，跳过 ${skipped} 个冲突点` : ''}`, planted ? 'info' : 'warn');
  }

  /* ---------------- 分区绘制 ---------------- */

  private addPoint(x: number, z: number): void {
    this.drawingPoints.push({ x, z });
    this.rebuildPreviewLine(null);
  }

  private undoPoint(): void {
    this.drawingPoints.pop();
    this.rebuildPreviewLine(null);
  }

  private updatePreviewLine(x: number, z: number): void {
    if (!this.drawingPoints.length) return;
    this.rebuildPreviewLine({ x, z });
  }

  private rebuildPreviewLine(cursor: { x: number; z: number } | null): void {
    if (this.previewLine) {
      this.view.scene.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }
    const pts = this.drawingPoints.map((p) => new THREE.Vector3(p.x, 0.1, p.z));
    if (cursor) pts.push(new THREE.Vector3(cursor.x, 0.1, cursor.z));
    if (pts.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.previewLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe082 }));
    this.view.scene.scene.add(this.previewLine);
  }

  private closeZone(): void {
    if (this.drawingPoints.length < 3) {
      toast('至少需要 3 个点才能闭合', 'warn');
      return;
    }
    this.ctx.store.addZone(this.zoneType, this.drawingPoints);
    this.clearDrawing();
    toast('分区已创建');
  }

  private clearDrawing(): void {
    this.drawingPoints = [];
    if (this.previewLine) {
      this.view.scene.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }
  }

  /* ---------------- 选中标记 ---------------- */

  private showMarker(id: number): void {
    this.hideMarker();
    const tree: TreeRecord | undefined = this.ctx.store.data.trees.find((t) => t.id === id);
    if (!tree) return;
    const geo = new THREE.TorusGeometry(1.2, 0.06, 8, 48);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x5b9bd5 });
    this.markerRing = new THREE.Mesh(geo, mat);
    this.markerRing.position.set(tree.x, 0.1, tree.z);
    this.view.scene.scene.add(this.markerRing);
  }

  private hideMarker(): void {
    if (!this.markerRing) return;
    this.view.scene.scene.remove(this.markerRing);
    this.markerRing.geometry.dispose();
    (this.markerRing.material as THREE.Material).dispose();
    this.markerRing = null;
  }

  /* ---------------- 状态条 ---------------- */

  private refreshStatus(): void {
    const modeText: Record<Mode, string> = {
      plant: '单株种植：移动鼠标定位，点击种下；可从苗木库直接拖入',
      brush: '片植刷：按住左键在地面拖动，按树冠间距自动蜂窝布点',
      zone: '分区绘制：点击描点，双击或 Enter 闭合，Esc 取消',
      select: '选择/移动：点击树木查看属性，Delete 删除选中树',
    };
    this.statusEl.textContent = modeText[this.mode];
    this.statusEl.className = 'status-bar';
  }

  private flashTimer = 0;
  private flashStatus(text: string, kind: 'info' | 'warn' | 'danger'): void {
    this.statusEl.textContent = text;
    this.statusEl.className = `status-bar ${kind === 'info' ? '' : kind}`;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.refreshStatus(), 2200);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.clearDrawing();
    this.hideMarker();
    if (this.brushCircle) {
      this.view.scene.scene.remove(this.brushCircle);
      this.brushCircle.geometry.dispose();
      (this.brushCircle.material as THREE.Material).dispose();
    }
    this.view.dispose();
    this.root?.remove();
  }
}
