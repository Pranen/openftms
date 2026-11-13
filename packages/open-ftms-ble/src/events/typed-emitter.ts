export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

/**
 * Minimal, fully typed event emitter.
 *
 * `Events` maps event names to payload types. A throwing listener does not
 * stop the others; its error is re-thrown asynchronously so it still shows up
 * in the console.
 */
export class TypedEmitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners.get(event)?.delete(listener as Listener<never>);
  }

  listenerCount(event: keyof Events): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
