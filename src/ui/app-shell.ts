import { h, toast } from './dom';
import type { Page, PageContext } from '../pages/page';
import type { AppStore } from '../core/store';
import { exportProjectFile, importProjectFile, saveToSlot, listSlots, loadFromSlot, deleteSlot } from '../core/storage';
import { confirmDialog, modal } from './dom';

const NAV: { id: string; label: string }[] = [
  { id: 'library', label: '苗木库' },
  { id: 'site', label: '场地编辑' },
  { id: 'preview', label: '三维预览' },
  { id: 'growth', label: '生长模拟' },
  { id: 'report', label: '汇报导出' },
];

export class AppShell {
  private pageEl: HTMLDivElement;
  private current: Page | null = null;
  private navButtons = new Map<string, HTMLButtonElement>();

  constructor(
    private store: AppStore,
    private pageFactory: (id: string) => Page,
  ) {
    this.pageEl = h('div', { className: 'page' });
    const shell = h('div', { className: 'app-shell' }, [
      this.buildTopbar(),
      this.pageEl,
    ]);
    document.getElementById('app')!.appendChild(shell);
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  private buildTopbar(): HTMLElement {
    const nameInput = h('input', {
      className: 'project-name',
      value: this.store.data.settings.name,
      onchange: () => {
        this.store.updateSettings({ name: nameInput.value || '未命名方案' });
      },
    }) as HTMLInputElement;

    const nav = h('nav', { className: 'nav' },
      NAV.map((n) => {
        const btn = h('button', {
          textContent: n.label,
          onclick: () => { location.hash = n.id; },
        });
        this.navButtons.set(n.id, btn);
        return btn;
      }),
    );

    return h('header', { className: 'topbar' }, [
      h('span', { className: 'logo' }, ['🌳 苗木配置与生长预览']),
      nameInput,
      nav,
      h('span', { className: 'spacer' }),
      h('button', {
        className: 'small ghost',
        textContent: '存档',
        onclick: () => this.openSlots(),
      }),
      h('button', {
        className: 'small',
        textContent: '导出',
        onclick: () => { exportProjectFile(this.store.data); toast('方案 JSON 已导出'); },
      }),
      h('button', {
        className: 'small',
        textContent: '导入',
        onclick: () => this.openImport(),
      }),
      h('button', {
        className: 'small danger',
        textContent: '清空',
        onclick: () => confirmDialog('将清空全部树木、分区与截图，确定？', () => {
          this.store.resetProject();
          toast('方案已重置');
          location.hash = 'library';
        }),
      }),
    ]);
  }

  private openSlots(): void {
    const wrap = h('div', { className: 'stack' });
    const render = (): void => {
      wrap.innerHTML = '';
      const slots = listSlots();
      if (!slots.length) wrap.appendChild(h('p', { className: 'muted' }, ['暂无存档，可先把当前方案存入新槽位']));
      for (const s of slots) {
        wrap.appendChild(h('div', { className: 'field' }, [
          h('div', {}, [h('div', { textContent: s.name }), h('div', { className: 'muted', textContent: new Date(s.updated).toLocaleString('zh-CN') })]),
          h('div', { className: 'row' }, [
            h('button', { className: 'small', textContent: '读取', onclick: () => {
              const data = loadFromSlot(s.id);
              if (data) { this.store.replaceProject(data); toast(`已读取存档：${s.name}`); }
            } }),
            h('button', { className: 'small danger', textContent: '删除', onclick: () => { deleteSlot(s.id); render(); } }),
          ]),
        ]));
      }
    };
    render();
    modal('方案存档', wrap, [
      {
        label: '存入新槽位',
        primary: true,
        onClick: () => {
          const id = `slot-${Date.now()}`;
          saveToSlot(this.store.data, id, this.store.data.settings.name);
          toast('已保存到浏览器');
          render();
          // 模态会关闭，重新打开查看
          setTimeout(() => this.openSlots(), 50);
        },
      },
      { label: '关闭', onClick: () => undefined },
    ]);
  }

  private openImport(): void {
    const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      importProjectFile(file)
        .then((data) => {
          this.store.replaceProject(data);
          toast('方案导入成功');
        })
        .catch(() => toast('文件解析失败，请使用系统导出的 JSON', 'error'));
    });
    modal('导入方案', h('div', { className: 'stack' }, [
      h('p', { className: 'muted' }, ['选择此前导出的方案 JSON 文件，当前方案将被覆盖。']),
      input,
    ]), [{ label: '取消', onClick: () => undefined }]);
  }

  private route(): void {
    const id = location.hash.replace('#', '') || 'library';
    const valid = NAV.some((n) => n.id === id) ? id : 'library';
    if (valid !== id) location.hash = valid;
    this.navButtons.forEach((btn, key) => btn.classList.toggle('active', key === valid));
    this.current?.dispose();
    this.pageEl.innerHTML = '';
    const page = this.pageFactory(valid);
    this.current = page;
    const ctx: PageContext = { store: this.store, mount: this.pageEl };
    page.mount(ctx);
  }
}
