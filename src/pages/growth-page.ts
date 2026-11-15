import type { Page, PageContext } from './page';
import { h, section, sliderRow, toast } from '../ui/dom';
import { createView, type ViewHandle } from './shared-view';
import { treeAge, treeHeight, growthScale } from '../core/growth';

export class GrowthPage implements Page {
  id = 'growth';
  title = '生长模拟';
  private root: HTMLElement | null = null;
  private view!: ViewHandle;
  private ctx!: PageContext;
  private playing = false;
  private playTimer = 0;
  private yearTag!: HTMLElement;
  private conflictTag!: HTMLElement;
  private issueList!: HTMLElement;

  mount(ctx: PageContext): void {
    this.ctx = ctx;
    const viewport = h('div', { className: 'viewport' });
    this.view = createView(viewport, ctx.store);

    this.yearTag = h('span', { className: 'chip' });
    this.conflictTag = h('span', { className: 'chip' });
    viewport.appendChild(h('div', { className: 'overlay hud' }, [this.yearTag, this.conflictTag]));

    const side = this.buildSidebar();
    this.root = h('div', { className: 'page' }, [side, viewport]);
    ctx.mount.appendChild(this.root);

    this.view.ensureSpecies(ctx.store.species);
    this.refresh();

    ctx.store.emitter.on((e) => {
      if (e.kind === 'structure' || e.kind === 'matrix') this.refresh();
    });
  }

  private buildSidebar(): HTMLElement {
    const s = this.ctx.store.data.settings;
    const maxYears = 30;

    const yearRow = sliderRow('生长年份（距种植）', s.yearOffset, 0, maxYears, 1,
      (v) => {
        this.ctx.store.updateSettings({ yearOffset: v });
        this.refresh();
      },
      (v) => `${v} 年`,
    );

    const playBtn = h('button', { className: 'primary', textContent: '▶ 播放生长（1 年/秒）' });
    playBtn.addEventListener('click', () => {
      if (this.playing) {
        this.stopPlay();
      } else {
        this.playing = true;
        playBtn.textContent = '⏸ 暂停';
        this.playTimer = window.setInterval(() => {
          const cur = this.ctx.store.data.settings.yearOffset;
          if (cur >= maxYears) {
            this.stopPlay();
            toast('已到达 30 年模拟上限');
            return;
          }
          this.ctx.store.updateSettings({ yearOffset: cur + 1 });
          this.refresh();
        }, 1000);
      }
    });

    const resetBtn = h('button', {
      textContent: '↺ 回到种植初年',
      onclick: () => {
        this.stopPlay();
        playBtn.textContent = '▶ 播放生长（1 年/秒）';
        this.ctx.store.updateSettings({ yearOffset: 0 });
        this.refresh();
      },
    });

    const stats = h('div', { className: 'stack' });
    const renderStats = (): void => {
      stats.innerHTML = '';
      const trees = this.ctx.store.data.trees;
      if (!trees.length) {
        stats.appendChild(h('p', { className: 'muted' }, ['场地内还没有树，先到「场地编辑」种植。']));
        return;
      }
      let totalH = 0;
      let maxH = 0;
      let minH = Infinity;
      const sample = trees.slice(0, 400); // 统计采样，避免长列表卡顿
      for (const t of sample) {
        const sp = this.ctx.store.getSpecies(t.speciesId);
        const hgt = treeHeight(sp, treeAge(t, this.ctx.store.data.settings));
        totalH += hgt;
        maxH = Math.max(maxH, hgt);
        minH = Math.min(minH, hgt);
      }
      const avg = totalH / sample.length;
      stats.append(
        statLine('平均树高', `${avg.toFixed(1)} m`),
        statLine('最高 / 最矮', `${maxH.toFixed(1)} / ${minH.toFixed(1)} m`),
        statLine('平均成熟度', `${(growthScale(this.ctx.store.getSpecies(sample[0].speciesId), treeAge(sample[0], this.ctx.store.data.settings)) * 100).toFixed(0)}%（样例）`),
      );
    };
    renderStats();
    this.ctx.store.emitter.on((e) => {
      if (e.kind === 'matrix' || e.kind === 'structure') renderStats();
    });

    this.issueList = h('div', { className: 'stack', style: 'max-height:260px;overflow-y:auto' });

    return h('div', { className: 'sidebar wide' }, [
      section('年份控制', yearRow, h('div', { className: 'row' }, [playBtn, resetBtn])),
      section('当前长势', stats),
      section('冠幅挤压冲突', this.issueList, h('p', { className: 'muted' }, ['随年份增长，树冠相交即标红；列表给出冲突双方与间距。'])),
      section('生长模型',
        h('p', { className: 'muted' }, [
          '采用渐近指数模型 s(age)=s₀+(1-s₀)(1-e^(-k·age))，s₀ 为出圃苗高比例，k 由树种生长速度决定。全部计算为纯函数，同年份反复播放结果一致。',
        ]),
      ),
    ]);
  }

  private stopPlay(): void {
    this.playing = false;
    window.clearInterval(this.playTimer);
  }

  private refresh(): void {
    const s = this.ctx.store.data.settings;
    this.yearTag.textContent = `第 ${s.yearOffset} 年（${s.startYear + s.yearOffset}）`;
    const issues = this.ctx.store.issues;
    this.conflictTag.textContent = `冠幅冲突 ${issues.length} 处`;
    this.conflictTag.style.color = issues.length ? '#e08a3c' : '';

    if (!this.issueList) return;
    this.issueList.innerHTML = '';
    if (!issues.length) {
      this.issueList.appendChild(h('p', { className: 'muted' }, ['✓ 无间距冲突']));
    } else {
      const top = issues.slice(0, 30);
      for (const it of top) {
        const a = this.ctx.store.data.trees.find((t) => t.id === it.treeId);
        const b = this.ctx.store.data.trees.find((t) => t.id === it.otherId);
        if (!a || !b) continue;
        const sa = this.ctx.store.getSpecies(a.speciesId);
        const sb = this.ctx.store.getSpecies(b.speciesId);
        this.issueList.appendChild(h('div', { className: 'field' }, [
          h('span', { style: 'font-size:12px' }, [
            `${sa.name}#${a.id} ↔ ${sb.name}#${b.id}`,
            h('div', { className: 'muted' }, [`间距 ${it.distance.toFixed(1)}m / 需 ${it.required.toFixed(1)}m`]),
          ]),
          h('button', {
            className: 'small',
            textContent: '定位',
            onclick: () => {
              this.view.scene.controls.target.set(a.x, 2, a.z);
              this.view.scene.camera.position.set(a.x + 18, 16, a.z + 18);
            },
          }),
        ]));
      }
      if (issues.length > 30) {
        this.issueList.appendChild(h('p', { className: 'muted' }, [`其余 ${issues.length - 30} 处从略…`]));
      }
    }
  }

  dispose(): void {
    this.stopPlay();
    this.view.dispose();
    this.root?.remove();
  }
}

function statLine(label: string, value: string): HTMLElement {
  return h('div', { className: 'spec-line' }, [h('span', {}, [label]), h('b', {}, [value])]);
}
