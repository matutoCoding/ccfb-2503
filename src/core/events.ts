/** 极简事件总线 */
type Handler<T> = (payload: T) => void;

export class Emitter<T = void> {
  private handlers = new Set<Handler<T>>();

  on(h: Handler<T>): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  emit(payload: T): void {
    this.handlers.forEach((h) => h(payload));
  }

  clear(): void {
    this.handlers.clear();
  }
}
