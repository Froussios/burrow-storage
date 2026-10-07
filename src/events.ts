/**
 * A typed event channel. It is a real EventTarget
 * (`addEventListener(type, e => e.detail)`) and also offers the
 * chrome.storage.onChanged listener shape (`addListener(fn)`), so either style
 * of call site works unchanged.
 */
export class BurrowEvent<T> extends EventTarget {
  readonly type: string;
  readonly #wrapped = new Map<(detail: T) => void, EventListener>();

  constructor(type: string) {
    super();
    this.type = type;
  }

  addListener(fn: (detail: T) => void): void {
    if (this.#wrapped.has(fn)) return;
    const l: EventListener = (e) => fn((e as CustomEvent<T>).detail);
    this.#wrapped.set(fn, l);
    this.addEventListener(this.type, l);
  }

  removeListener(fn: (detail: T) => void): void {
    const l = this.#wrapped.get(fn);
    if (!l) return;
    this.removeEventListener(this.type, l);
    this.#wrapped.delete(fn);
  }

  hasListener(fn: (detail: T) => void): boolean {
    return this.#wrapped.has(fn);
  }

  /** @internal */
  emit(detail: T): void {
    this.dispatchEvent(new CustomEvent(this.type, { detail }));
  }
}
