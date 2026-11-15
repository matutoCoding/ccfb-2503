/** 通用 UI 工具：DOM 构建、Toast、模态框、滑块行 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & {
    dataset?: Record<string, string>;
    style?: string | Partial<CSSStyleDeclaration>;
  } = {},
  children: (Node | string | null | undefined | false)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (k === 'class') {
      el.className = v as string;
    } else if (k === 'style' && typeof v === 'string') {
      el.setAttribute('style', v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      (el as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/* ---------------- Toast ---------------- */

let toastWrap: HTMLDivElement | null = null;

export function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info', duration = 2600): void {
  if (!toastWrap) {
    toastWrap = h('div', { className: 'toast-wrap' });
    document.body.appendChild(toastWrap);
  }
  const el = h('div', { className: `toast ${kind === 'info' ? '' : kind}` }, [message]);
  toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 320);
  }, duration);
}

/* ---------------- 模态框 ---------------- */

export function modal(title: string, content: Node, actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void }[]): () => void {
  const mask = h('div', { className: 'modal-mask' });
  const actionEls = actions.map((a) =>
    h('button', {
      className: a.primary ? 'primary' : a.danger ? 'danger' : '',
      textContent: a.label,
      onclick: () => {
        a.onClick();
        close();
      },
    }),
  );
  const dialog = h('div', { className: 'modal' }, [
    h('h2', {}, [title]),
    content,
    h('div', { className: 'actions' }, actionEls),
  ]);
  mask.appendChild(dialog);
  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask) close();
  });
  document.body.appendChild(mask);
  function close(): void {
    mask.remove();
  }
  return close;
}

export function confirmDialog(message: string, onOk: () => void): void {
  modal('请确认', h('p', {}, [message]), [
    { label: '取消', onClick: () => undefined },
    { label: '确定', danger: true, onClick: onOk },
  ]);
}

/* ---------------- 表单行 ---------------- */

export function sliderRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(step < 1 ? 1 : 0),
): HTMLDivElement {
  const val = h('span', { className: 'value-tag', textContent: fmt(value) });
  const input = h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: () => {
      const v = Number(input.value);
      val.textContent = fmt(v);
      onChange(v);
    },
  });
  return h('div', { className: 'field' }, [h('label', {}, [label]), input, val]);
}

export function selectRow(label: string, options: { value: string; text: string }[], current: string, onChange: (v: string) => void): HTMLDivElement {
  const sel = h('select', {
    onchange: () => onChange(sel.value),
  }, options.map((o) => h('option', { value: o.value, textContent: o.text, selected: o.value === current })));
  return h('div', { className: 'field' }, [h('label', {}, [label]), sel]);
}

export function section(title: string, ...children: Node[]): HTMLDivElement {
  return h('div', { className: 'panel-section' }, [h('h3', {}, [title]), ...children]);
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
