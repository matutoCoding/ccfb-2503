import type { Page, PageContext } from './page';
import { h, section, toast, downloadText, confirmDialog } from '../ui/dom';
import { createView, type ViewHandle } from './shared-view';
import { tToMonthDay } from '../core/season';
import { treeAge, treeHeight } from '../core/growth';

export class ReportPage implements Page {
  id = 'report';
  title = '汇报导出';
  private root: HTMLElement | null = null;
  private view!: ViewHandle;
  private ctx!: PageContext;
  private snapWrap!: HTMLElement;

  mount(ctx: PageContext): void {
    this.ctx = ctx;
    const viewport = h('div', { className: 'viewport', style: 'flex:1.6' });
    this.view = createView(viewport, ctx.store);

    const hint = h('div', { className: 'overlay status-bar' }, ['调整好视角与季节后，点击右侧「截取当前视角」存入汇报材料']);
    viewport.appendChild(hint);

    this.snapWrap = h('div', { className: 'snapshot-grid' });
    const side = h('div', { className: 'sidebar wide', style: 'width:380px;overflow-y:auto' }, [
      section('汇报截图',
        h('div', { className: 'stack' }, [
          h('button', {
            className: 'primary',
            textContent: '📷 截取当前视角',
            onclick: () => this.takeSnapshot(),
          }),
        ]),
        this.snapWrap,
      ),
      section('苗木清单', this.buildInventory()),
      section('导出',
        h('div', { className: 'stack' }, [
          h('button', { textContent: '导出苗木清单 CSV（Excel 可打开）', onclick: () => this.exportCsv() }),
          h('button', { textContent: '打印 / 另存 PDF 汇报书', onclick: () => this.printReport() }),
          h('button', { className: 'danger', textContent: '清空全部截图', onclick: () => {
            confirmDialog('确定清空全部汇报截图？', () => {
              this.ctx.store.data.snapshots = [];
              this.ctx.store.emitter.emit({ kind: 'project' });
            });
          } }),
        ]),
      ),
    ]);

    this.root = h('div', { className: 'page' }, [side, viewport]);
    ctx.mount.appendChild(this.root);
    this.view.ensureSpecies(ctx.store.species);
    this.renderSnapshots();
    ctx.store.emitter.on((e) => { if (e.kind === 'project') this.renderSnapshots(); });
  }

  private takeSnapshot(): void {
    // 先渲染一帧确保缓冲最新
    const dataUrl = this.view.scene.screenshot();
    const s = this.ctx.store.data.settings;
    const md = tToMonthDay(s.seasonT);
    const name = `${s.startYear + s.yearOffset}年${md.month}月${md.day}日 ${this.ctx.store.data.trees.length}株`;
    this.ctx.store.addSnapshot(name, dataUrl);
    toast('截图已保存到方案');
  }

  private renderSnapshots(): void {
    this.snapWrap.innerHTML = '';
    const snaps = this.ctx.store.data.snapshots;
    if (!snaps.length) {
      this.snapWrap.appendChild(h('p', { className: 'muted' }, ['暂无截图，最多保留 12 张']));
      return;
    }
    for (const snap of snaps) {
      const card = h('div', { className: 'snapshot-card' }, [
        h('img', { src: snap.dataUrl, alt: snap.name }),
        h('div', { className: 'cap' }, [
          h('div', { textContent: snap.name }),
          h('div', { className: 'muted' }, [snap.date]),
          h('div', { className: 'row', style: 'margin-top:6px' }, [
            h('button', { className: 'small', textContent: '下载 PNG', onclick: () => {
              const a = h('a', { href: snap.dataUrl, download: `${snap.name}.png` });
              a.click();
            } }),
            h('button', { className: 'small danger', textContent: '删除', onclick: () => this.ctx.store.removeSnapshot(snap.id) }),
          ]),
        ]),
      ]);
      this.snapWrap.appendChild(card);
    }
  }

  private buildInventory(): HTMLElement {
    const inv = this.ctx.store.inventory();
    const wrap = h('div', { style: 'max-height:300px;overflow-y:auto' });
    if (!inv.length) {
      wrap.appendChild(h('p', { className: 'muted' }, ['暂无苗木']));
      return wrap;
    }
    const table = h('table', { className: 'list' });
    table.append(
      h('thead', {}, [h('tr', {}, [
        h('th', {}, ['树种']),
        h('th', { className: 'num' }, ['数量']),
        h('th', { className: 'num' }, ['树高 m']),
        h('th', { className: 'num' }, ['冠幅 m']),
        h('th', { className: 'num' }, ['单价']),
        h('th', { className: 'num' }, ['小计']),
      ])]),
      h('tbody', {}, inv.map((it) => h('tr', {}, [
        h('td', {}, [it.species.name]),
        h('td', { className: 'num' }, [String(it.count)]),
        h('td', { className: 'num' }, [String(it.matureHeight)]),
        h('td', { className: 'num' }, [String(it.crownWidth)]),
        h('td', { className: 'num' }, [`¥${it.species.cost}`]),
        h('td', { className: 'num' }, [`¥${it.subtotal.toLocaleString()}`]),
      ]))),
    );
    wrap.appendChild(table);
    wrap.appendChild(h('p', { className: 'spec-line', style: 'margin-top:8px' }, [
      h('b', {}, [`合计 ${inv.reduce((n, i) => n + i.count, 0)} 株`]),
      h('b', {}, [`¥${this.ctx.store.totalCost().toLocaleString()}`]),
    ]));
    return wrap;
  }

  private exportCsv(): void {
    const inv = this.ctx.store.inventory();
    if (!inv.length) { toast('暂无苗木可导出', 'warn'); return; }
    const rows = [
      ['序号', '树种', '拉丁名', '类别', '数量', '成年树高(m)', '成年冠幅(m)', '出圃苗高(m)', '单价(元/株)', '小计(元)'],
      ...inv.map((it, i) => [
        i + 1, it.species.name, it.species.latin, it.species.category, it.count,
        it.species.matureHeight, it.species.crownWidth, it.species.saplingHeight,
        it.species.cost, it.subtotal,
      ]),
      [],
      ['合计', '', '', '', inv.reduce((n, i) => n + i.count, 0), '', '', '', '', this.ctx.store.totalCost()],
    ];
    const csv = rows.map((r) => r.map((c) => {
      const str = String(c ?? '');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',')).join('\r\n');
    downloadText(`${this.ctx.store.data.settings.name}-苗木清单.csv`, csv, 'text/csv;charset=utf-8');
    toast('苗木清单 CSV 已导出');
  }

  /** 打开打印友好的汇报书窗口（含截图、清单、当前长势统计） */
  private printReport(): void {
    const s = this.ctx.store.data.settings;
    const inv = this.ctx.store.inventory();
    const md = tToMonthDay(s.seasonT);
    const trees = this.ctx.store.data.trees;
    const avgNow = trees.length
      ? trees.reduce((sum, t) => {
        const sp = this.ctx.store.getSpecies(t.speciesId);
        return sum + treeHeight(sp, treeAge(t, s));
      }, 0) / trees.length
      : 0;

    const win = window.open('', '_blank');
    if (!win) { toast('浏览器拦截了弹出窗口，请允许弹窗', 'error'); return; }
    const snapshots = this.ctx.store.data.snapshots.map((sn) => `<figure><img src="${sn.dataUrl}"/><figcaption>${sn.name} · ${sn.date}</figcaption></figure>`).join('');
    const rows = inv.map((it, i) => `<tr><td>${i + 1}</td><td>${it.species.name}</td><td><i>${it.species.latin}</i></td><td>${it.species.category}</td><td style="text-align:right">${it.count}</td><td style="text-align:right">${it.species.matureHeight}</td><td style="text-align:right">${it.species.crownWidth}</td><td style="text-align:right">¥${it.species.cost}</td><td style="text-align:right">¥${it.subtotal.toLocaleString()}</td></tr>`).join('');
    win.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${s.name} - 苗木配置汇报书</title>
<style>
  body { font-family: 'Microsoft YaHei', sans-serif; margin: 32px; color: #222; }
  h1 { color: #3a5f25; border-bottom: 3px solid #7cb342; padding-bottom: 10px; }
  h2 { color: #3a5f25; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 10px; }
  th, td { border: 1px solid #999; padding: 7px 9px; }
  th { background: #eef5e6; }
  .meta { color: #666; font-size: 13px; line-height: 1.9; }
  figure { display: inline-block; margin: 8px; width: 46%; vertical-align: top; }
  figure img { width: 100%; border: 1px solid #ccc; }
  figcaption { font-size: 12px; color: #666; margin-top: 4px; }
  .total { font-weight: 700; font-size: 15px; margin-top: 12px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<h1>${s.name} · 苗木配置与生长预览汇报书</h1>
<div class="meta">
  模拟年份：${s.startYear + s.yearOffset} 年（种植后第 ${s.yearOffset} 年）　物候日期：${md.month}月${md.day}日<br/>
  苗木总数：${trees.length} 株　树种数：${inv.length} 种　当前平均树高：${avgNow.toFixed(1)} m<br/>
  冠幅间距冲突：${this.ctx.store.issues.length} 处　苗木概算：¥${this.ctx.store.totalCost().toLocaleString()}
</div>
<h2>效果截图</h2>
${snapshots || '<p>暂无截图</p>'}
<h2>苗木清单</h2>
<table><thead><tr><th>序号</th><th>树种</th><th>拉丁名</th><th>类别</th><th style="text-align:right">数量</th><th style="text-align:right">成年树高(m)</th><th style="text-align:right">成年冠幅(m)</th><th style="text-align:right">单价</th><th style="text-align:right">小计</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="total">合计：${inv.reduce((n, i) => n + i.count, 0)} 株　¥${this.ctx.store.totalCost().toLocaleString()}</p>
<p class="noprint" style="margin-top:30px"><button onclick="window.print()" style="padding:10px 26px;font-size:15px;background:#558b2f;color:#fff;border:none;border-radius:6px;cursor:pointer">打印 / 另存为 PDF</button></p>
</body></html>`);
    win.document.close();
  }

  dispose(): void {
    this.view.dispose();
    this.root?.remove();
  }
}
