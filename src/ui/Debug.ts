import type { World } from '../types';
import { el, setText } from './dom';

/**
 * The F3 overlay. It belongs to the layer rather than to either HUD so that
 * `settings.debug` shows the same numbers in both modes — several agents read
 * this while profiling and a mode that silently hid it would waste their time.
 */
export class DebugOverlay {
  readonly root: HTMLElement;

  constructor() {
    this.root = el('pre', 'dbg');
  }

  update(world: World): void {
    const s = world.stats;
    let out = `${world.time.fps.toFixed(0)} fps   ${(s.drawCalls ?? 0) | 0} dc   ${((s.triangles ?? 0) / 1e6).toFixed(2)} Mtri   ${(s.programs ?? 0) | 0} prog\n`;
    out += `scale ${world.settings.renderScale.toFixed(2)}   ${world.size.width}×${world.size.height}\n`;
    const keys: string[] = [];
    for (const k in s) if (k.startsWith('upd:')) keys.push(k);
    keys.sort((a, b) => s[b] - s[a]);
    for (const k of keys.slice(0, 8)) out += `${k.slice(4).padEnd(9)} ${s[k].toFixed(2)} ms\n`;
    if (s['ui:ms'] !== undefined) out += `ui(self)  ${s['ui:ms'].toFixed(3)} ms`;
    setText(this.root, out);
  }
}
