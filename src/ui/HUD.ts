import type { Module, World } from '../types';

/** PLACEHOLDER — replaced by the full HUD + settings drawer. */
export class HUD implements Module {
  readonly name = 'ui';
  private el!: HTMLElement;

  init(world: World): void {
    const root = document.getElementById('ui-root')!;
    this.el = document.createElement('div');
    this.el.className = 'hud-debug';
    root.appendChild(this.el);
    void world;
  }

  update(world: World): void {
    if (world.time.frame % 6 !== 0) return;
    const s = world.ship;
    this.el.textContent =
      `${s.speedKnots.toFixed(1)} kn   ` +
      `HDG ${((s.heading * 180) / Math.PI + 360).toFixed(0).padStart(3, '0')}°   ` +
      `WIND ${(world.env.windSpeed * 1.94384).toFixed(0)} kn   ` +
      `${world.time.fps.toFixed(0)} fps`;
  }
}
