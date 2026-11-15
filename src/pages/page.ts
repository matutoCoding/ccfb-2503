import type { AppStore } from '../core/store';

export interface PageContext {
  store: AppStore;
  mount: HTMLElement;
}

export interface Page {
  id: string;
  title: string;
  mount(ctx: PageContext): void;
  dispose(): void;
}
