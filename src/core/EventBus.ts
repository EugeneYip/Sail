import type { EventBus } from '../types';

export function createEventBus(): EventBus {
  const map = new Map<string, Set<(p?: unknown) => void>>();
  return {
    on(event, fn) {
      let set = map.get(event);
      if (!set) map.set(event, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    off(event, fn) {
      map.get(event)?.delete(fn);
    },
    emit(event, payload) {
      const set = map.get(event);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[bus] handler for "${event}" threw`, err);
        }
      }
    },
  };
}
