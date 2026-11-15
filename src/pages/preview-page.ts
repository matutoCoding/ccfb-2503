import type { Page, PageContext } from './page';
import { h, section, sliderRow, selectRow, toast } from '../ui/dom';
import { createView, type ViewHandle } from './shared-view';
import { SEASON_LABELS, tToMonthDay } from '../core/season';
import type { QualityLevel } from '../core/types';

export class PreviewPage implements Page {
  id = 'preview';
  title = '三维预览';
  private root: HTMLElement | null = null;
  private view!: ViewHandle;
  private ctx!: PageContext;
  private hudFps!: HTMLElement;
  private hudDraw!: HTMLElement;
  private hudTri!: HTMLElement;
  private hudDate!: HTMLElement;
  private timer = 0;

  mount(ctx: PageContext): void {
    this.ctx = ctx;
    const viewport = h('div', { className: 'viewport' });
    this.view = createView(viewport, ctx.store);

    this.hudFps = h('span', { className: 'chip' }, ['FPS ', h('b', {})]);
    this.hudDraw = h('span', { className: 'chip' }, ['DrawCall ', h('b', {})]);
    this.hudTri = h('span', { className: 'chip' }, ['三角面 ', h('b', {})]);
    this.hudDate = h('span', { className: 'chip' });
    const countChip = h('span', { className: 'chip' }, ['树木 ', h('b', { textContent: String(ctx.store.data.trees.length) })]);
    const hud = h('div', { className: 'overlay hud' }, [this.hudDate, countChip, this.hudFps, this.hudDraw, this.hudTri]);
    viewport.appendChild(hud);

    const side = this.buildSidebar();
    this.root = h('div', { className: 'page' }, [side, viewport]);
    ctx.mount.appendChild(this.root);

    this.view.ensureSpecies(ctx.store.species);
    this.refreshHudDate();

    // 性能 HUD 每 0.5s 刷新
    this.timer = window.setInterval(() => {
      const info = this.view.scene.getFps();
      (this.hudFps.querySelector('b') as HTMLElement).textContent = String(info.fps);
      (this.hudDraw.querySelector('b') as HTMLElement).textContent = String(info.drawCalls);
      (this.hudTri.querySelector('b') as HTMLElement).textContent = info.triangles > 10000
        ? `${(info.triangles / 10000).toFixed(1)}万`
        : String(info.triangles);
      (countChip.querySelector('b') as HTMLElement).textContent = String(ctx.store.data.trees.length);
    }, 500);
  }

  private buildSidebar(): HTMLElement {
    const s = this.ctx.store.data.settings;

    const seasonBtns = h('div', { className: 'seg-group' }, SEASON_LABELS.map((sl) =>
      h('button', {
        textContent: sl.label,
        onclick: () => {
          this.ctx.store.updateSettings({ seasonT: sl.t });
          this.refreshHudDate();
        },
      }),
    ));

    const dateRow = sliderRow('年内日期（日序）', Math.round(s.seasonT * 365) + 1, 1, 365, 1,
      (v) => {
        this.ctx.store.updateSettings({ seasonT: (v - 1) / 365 });
        this.refreshHudDate();
      },
      (v) => {
        const md = tToMonthDay((v - 1) / 365);
        return `${md.month}/${md.day}`;
      },
    );

    const hourRow = sliderRow('时刻（小时）', s.hour, 5, 20, 0.5,
      (v) => {
        this.ctx.store.updateSettings({ hour: v });
        this.refreshHudDate();
      },
      (v) => `${String(Math.floor(v)).padStart(2, '0')}:${v % 1 ? '30' : '00'}`,
    );

    const windRow = sliderRow('风力', s.wind, 0, 1, 0.05,
      (v) => this.ctx.store.updateSettings({ wind: v }),
      (v) => v.toFixed(2),
    );

    const qualityRow = selectRow('画质档位', [
      { value: 'low', text: '低（远景优先）' },
      { value: 'medium', text: '中（推荐）' },
      { value: 'high', text: '高（阴影 4K）' },
    ], s.quality, (v) => {
      this.ctx.store.updateSettings({ quality: v as QualityLevel });
      this.view.scene.setQuality(v as QualityLevel);
      this.view.refreshLod();
      toast(`已切换到${{ low: '低', medium: '中', high: '高' }[v as QualityLevel]}画质`);
    });

    const shadowBtn = h('button', {
      textContent: s.shadow ? '阴影：开' : '阴影：关',
      onclick: () => {
        const next = !this.ctx.store.data.settings.shadow;
        this.ctx.store.updateSettings({ shadow: next });
        this.view.scene.setQuality(this.ctx.store.data.settings.quality);
        shadowBtn.textContent = next ? '阴影：开' : '阴影：关';
      },
    });

    const matureBtn = h('button', {
      textContent: s.spacingByMature ? '间距口径：成年冠幅' : '间距口径：当前冠幅',
      onclick: () => {
        const next = !this.ctx.store.data.settings.spacingByMature;
        this.ctx.store.updateSettings({ spacingByMature: next });
        this.ctx.store.runSpacing();
        this.ctx.store.emitter.emit({ kind: 'structure' });
        matureBtn.textContent = next ? '间距口径：成年冠幅' : '间距口径：当前冠幅';
      },
    });

    const camBtn = h('button', {
      textContent: '复位视角',
      onclick: () => {
        const c = this.view.scene.camera;
        c.position.set(70, 60, 90);
        this.view.scene.controls.target.set(0, 0, 0);
      },
    });

    return h('div', { className: 'sidebar' }, [
      section('四季切换', seasonBtns, h('p', { className: 'muted' }, ['叶色、落叶量、花期随年相连贯变化，冬季落叶树保留秃枝。'])),
      section('太阳与日期', dateRow, hourRow),
      section('环境', windRow, qualityRow, h('div', { className: 'stack' }, [shadowBtn, matureBtn, camBtn])),
      section('渲染说明',
        h('p', { className: 'muted' }, [
          '近景高模 → 中景低模 → 远景圆柱公告板三级 LOD，全部走 InstancedMesh；风摆与季节变化在 GPU 着色器中完成，树木增减无需重建几何。',
        ]),
      ),
    ]);
  }

  private refreshHudDate(): void {
    const s = this.ctx.store.data.settings;
    const md = tToMonthDay(s.seasonT);
    const hh = String(Math.floor(s.hour)).padStart(2, '0');
    const mm = s.hour % 1 ? '30' : '00';
    this.hudDate.textContent = `${s.startYear + s.yearOffset}年 ${md.month}月${md.day}日 ${hh}:${mm}`;
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.view.dispose();
    this.root?.remove();
  }
}
