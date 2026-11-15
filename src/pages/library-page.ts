import * as THREE from 'three';
import type { Page, PageContext } from './page';
import type { TreeSpecies, TreeCategory, TreeForm } from '../core/types';
import { h, section, sliderRow, modal, toast, selectRow } from '../ui/dom';
import { loadSpeciesAsset, prewarmSpecies } from '../tree/model-library';
import { hashString } from '../core/rng';
import { exportSpeciesLibrary } from '../core/storage';

/** 用离屏公告板纹理画苗木卡片缩略图 */
function thumbnailCanvas(sp: TreeSpecies): HTMLCanvasElement {
  const asset = loadSpeciesAsset(sp, 0.55);
  const src = asset.billboardTexture.image as HTMLCanvasElement;
  const tile = src.width / 4;
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 150;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 150);
  grad.addColorStop(0, '#b8d4e8');
  grad.addColorStop(0.68, '#dfe9d5');
  grad.addColorStop(0.68, '#8aa868');
  grad.addColorStop(1, '#7b9a5c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 200, 150);
  ctx.drawImage(src, 0, 0, tile, src.height, 55, 8, 90, 138);
  return c;
}

function speciesCard(sp: TreeSpecies, ctx: PageContext): HTMLElement {
  const card = h('div', { className: 'species-card draggable', draggable: true, dataset: { speciesId: sp.id } });
  let thumb: HTMLCanvasElement | null = null;

  const lazy = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting && !thumb) {
        try {
          thumb = thumbnailCanvas(sp);
          card.querySelector('.thumb')!.appendChild(thumb);
        } catch {
          // WebGL 上下文暂不可用时静默
        }
        lazy.disconnect();
      }
    }
  }, { rootMargin: '60px' });
  lazy.observe(card);

  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    e.dataTransfer!.setData('application/x-species', sp.id);
    e.dataTransfer!.effectAllowed = 'copy';
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  const tags: HTMLElement[] = [h('span', { className: `tag ${sp.evergreen ? 'evergreen' : ''}`, textContent: sp.category })];
  if (sp.evergreen) tags.push(h('span', { className: 'tag evergreen', textContent: '常绿' }));
  if (sp.flowerColor) tags.push(h('span', { className: 'tag flower', textContent: '花期开花' }));
  if (sp.custom) tags.push(h('span', { className: 'tag', textContent: '自定义' }));

  card.append(
    h('div', { className: 'thumb' }),
    h('div', { className: 'body' }, [
      h('div', { className: 'name', textContent: sp.name }),
      h('div', { className: 'latin', textContent: sp.latin }),
      h('div', { className: 'tags' }, tags),
      specLine('成年树高', `${sp.matureHeight} m`),
      specLine('成年冠幅', `${sp.crownWidth} m`),
      specLine('出圃苗高', `${sp.saplingHeight} m`),
      specLine('生长速度', sp.growthRate >= 1.1 ? '快' : sp.growthRate >= 0.85 ? '中等' : '慢'),
      specLine('参考单价', `¥${sp.cost} / 株`),
      h('div', { className: 'row', style: 'margin-top:10px' }, [
        h('button', {
          className: 'small primary',
          textContent: '去场地种植 →',
          onclick: () => {
            location.hash = 'site';
            sessionStorage.setItem('plant-species', sp.id);
          },
        }),
        sp.custom ? h('button', {
          className: 'small danger',
          textContent: '删除',
          onclick: () => {
            ctx.store.data.customSpecies = ctx.store.data.customSpecies.filter((c) => c.id !== sp.id);
            ctx.store.emitter.emit({ kind: 'project' });
            toast(`已删除自定义树种 ${sp.name}`);
          },
        }) : null,
      ]),
    ]),
  );
  return card;
}

function specLine(label: string, value: string): HTMLElement {
  return h('div', { className: 'spec-line' }, [h('span', {}, [label]), h('b', {}, [value])]);
}

/* ---------------- 自定义树种编辑模态 ---------------- */

function openCustomEditor(ctx: PageContext, preset?: TreeSpecies): void {
  const form = h('div', { className: 'stack' });
  const nameInput = h('input', { value: preset?.name ?? '', placeholder: '中文名，如：二乔玉兰' }) as HTMLInputElement;
  const latinInput = h('input', { value: preset?.latin ?? '', placeholder: '拉丁名（可选）' }) as HTMLInputElement;
  const categorySel = h('select', {}, (['落叶乔木', '常绿乔木', '针叶树', '花乔', '灌木'] as TreeCategory[]).map(
    (c) => h('option', { value: c, textContent: c, selected: preset?.category === c }),
  )) as HTMLSelectElement;
  const formSel = h('select', {}, (['broad', 'round', 'conifer', 'weeping'] as TreeForm[]).map(
    (f) => h('option', { value: f, textContent: { broad: '开张形', round: '圆冠形', conifer: '塔形针叶', weeping: '垂枝形' }[f], selected: preset?.form === f }),
  )) as HTMLSelectElement;

  const state = {
    matureHeight: preset?.matureHeight ?? 12,
    crownWidth: preset?.crownWidth ?? 8,
    saplingHeight: preset?.saplingHeight ?? 2,
    branchDepth: preset?.branchDepth ?? 5,
    branchDensity: preset?.branchDensity ?? 1,
    branchAngle: preset?.branchAngle ?? 42,
    crownFill: preset?.crownFill ?? 1.1,
    leafDensity: preset?.leafDensity ?? 0.92,
    growthRate: preset?.growthRate ?? 1,
    cost: preset?.cost ?? 200,
  };

  form.append(
    h('div', { className: 'field' }, [h('label', {}, ['名称']), nameInput]),
    h('div', { className: 'field' }, [h('label', {}, ['拉丁名']), latinInput]),
    h('div', { className: 'field' }, [h('label', {}, ['类别']), categorySel]),
    h('div', { className: 'field' }, [h('label', {}, ['树形']), formSel]),
    sliderRow('成年树高 m', state.matureHeight, 3, 30, 0.5, (v) => (state.matureHeight = v)),
    sliderRow('成年冠幅 m', state.crownWidth, 2, 18, 0.5, (v) => (state.crownWidth = v)),
    sliderRow('出圃苗高 m', state.saplingHeight, 0.5, 5, 0.1, (v) => (state.saplingHeight = v)),
    sliderRow('分枝深度', state.branchDepth, 3, 6, 1, (v) => (state.branchDepth = v)),
    sliderRow('分枝密度', state.branchDensity, 0.6, 1.4, 0.05, (v) => (state.branchDensity = v), (v) => v.toFixed(2)),
    sliderRow('分枝倾角 °', state.branchAngle, 25, 65, 1, (v) => (state.branchAngle = v)),
    sliderRow('树冠密实度', state.crownFill, 0.5, 1.5, 0.05, (v) => (state.crownFill = v), (v) => v.toFixed(2)),
    sliderRow('叶片密度', state.leafDensity, 0.5, 1, 0.02, (v) => (state.leafDensity = v), (v) => v.toFixed(2)),
    sliderRow('生长速度', state.growthRate, 0.5, 1.6, 0.05, (v) => (state.growthRate = v), (v) => v.toFixed(2)),
    sliderRow('单价 元', state.cost, 10, 2000, 10, (v) => (state.cost = v)),
  );

  modal(preset ? '编辑自定义树种' : '新建自定义树种', form, [
    { label: '取消', onClick: () => undefined },
    {
      label: '保存并生成模型',
      primary: true,
      onClick: () => {
        if (!nameInput.value.trim()) {
          toast('请填写树种名称', 'warn');
          return;
        }
        const sp: TreeSpecies = {
          id: preset?.id ?? `custom-${hashString(nameInput.value + Date.now())}`,
          name: nameInput.value.trim(),
          latin: latinInput.value.trim() || '—',
          category: categorySel.value as TreeCategory,
          form: formSel.value as TreeForm,
          ...state,
          trunkDbh: Math.round(state.matureHeight * 2.2),
          evergreen: categorySel.value === '常绿乔木' || categorySel.value === '针叶树',
          flowerColor: categorySel.value === '花乔' ? 0xf2c0d4 : null,
          flowerPhase: categorySel.value === '花乔' ? [0.24, 0.32] : null,
          colorSpring: 0x82b566,
          colorSummer: 0x3f7a40,
          colorAutumn: 0xc98a3c,
          custom: true,
        };
        ctx.store.data.customSpecies = ctx.store.data.customSpecies.filter((c) => c.id !== sp.id);
        ctx.store.addCustomSpecies(sp);
        prewarmSpecies([sp], ctx.store.data.settings.seasonT)
          .then(() => toast(`树种「${sp.name}」模型已生成`))
          .catch(() => toast('模型生成失败', 'error'));
      },
    },
  ]);
}

export class LibraryPage implements Page {
  id = 'library';
  title = '苗木库';
  private root: HTMLElement | null = null;
  private ctx!: PageContext;

  mount(ctx: PageContext): void {
    this.ctx = ctx;
    const grid = h('div', { className: 'species-grid', style: 'flex:1;min-height:0' });
    const render = (): void => {
      grid.innerHTML = '';
      for (const sp of ctx.store.species) grid.appendChild(speciesCard(sp, ctx));
    };
    render();
    ctx.store.emitter.on((e) => {
      if (e.kind === 'project') render();
    });

    const side = h('div', { className: 'sidebar' }, [
      section('苗木库',
        h('p', { className: 'muted' }, [
          `内置 15 种常见园林苗木，所有树形均由参数程序化生成；同树种含 3 个共享几何变体，实例再做旋转与冠幅微抖动。`,
        ]),
      ),
      section('操作',
        h('div', { className: 'stack' }, [
          h('button', { className: 'primary', textContent: '＋ 新建自定义树种', onclick: () => openCustomEditor(ctx) }),
          h('button', {
            textContent: '预生成全部模型',
            onclick: () => {
              prewarmSpecies(ctx.store.species, ctx.store.data.settings.seasonT, (d, t) => {
                toast(`模型生成中 ${d}/${t}`);
              }).then(() => toast('全部树种模型就绪'));
            },
          }),
          h('button', {
            textContent: '导出树种参数库 JSON',
            onclick: () => exportSpeciesLibrary(ctx.store.data.customSpecies),
          }),
        ]),
      ),
      section('确定性说明',
        h('p', { className: 'muted' }, [
          '树木生成全程使用种子随机数（mulberry32），不调用 Math.random。相同树种与变体在任何浏览器、任何时间生成的网格逐顶点一致；场地中每棵树的种子由坐标与序号派生，可复现。',
        ]),
      ),
    ]);

    this.root = h('div', { className: 'page' }, [side, grid]);
    ctx.mount.appendChild(this.root);
  }

  dispose(): void {
    this.root?.remove();
  }
}
