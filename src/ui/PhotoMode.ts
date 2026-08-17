import type { World } from '../types';
import { action, slider, type Ctl } from './controls';
import { add, el, setClass } from './dom';

/**
 * Photo mode: instruments away, a slim bar of optical controls, one shutter.
 *
 * `focusDistance` is re-asserted every frame from `applyOverrides` because the
 * camera rig recomputes it from the look target. The UI module runs after the
 * camera and before the render hook, so the value the post stack reads is ours.
 */
export class PhotoMode {
  readonly root: HTMLElement;
  onShot: () => void = () => {};

  private world: World;
  private ctls: Ctl[] = [];
  private active_ = false;
  private focus = 80;
  private prevDof = true;

  constructor(world: World) {
    this.world = world;
    this.root = el('div', 'photo');
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Photo mode');

    const bar = add(this.root, el('div', 'photo-bar'));

    const commit = (): void => this.world.bus.emit('settings:changed');
    const none = (): void => {};

    this.ctls.push(slider(bar, {
      label: 'Aperture', min: 1.2, max: 22, step: 0.1,
      get: () => world.cam.aperture,
      set: (v) => (world.cam.aperture = v),
      fmt: (v) => `f/${v.toFixed(1)}`,
    }, none));

    this.ctls.push(slider(bar, {
      label: 'Focus', min: 3, max: 2400, step: 1,
      get: () => this.focus,
      set: (v) => (this.focus = v),
      fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${Math.round(v)} m`),
    }, none));

    this.ctls.push(slider(bar, {
      label: 'Field of view', min: 20, max: 95, step: 1,
      get: () => world.settings.fov,
      set: (v) => (world.settings.fov = v),
      fmt: (v) => `${v}°`,
    }, commit));

    this.ctls.push(slider(bar, {
      label: 'Exposure', min: -3, max: 3, step: 0.05,
      get: () => world.settings.exposureBias,
      set: (v) => (world.settings.exposureBias = v),
      fmt: (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV`,
    }, commit));

    this.ctls.push(action(bar, 'Frame', 'save', () => this.onShot()));
    add(this.root, el('div', 'photo-hint', 'F2 or Esc to return'));
  }

  get active(): boolean {
    return this.active_;
  }

  enter(): void {
    if (this.active_) return;
    this.active_ = true;
    this.focus = this.world.cam.focusDistance;
    // An aperture control with depth of field switched off is a lie.
    this.prevDof = this.world.settings.depthOfField;
    this.world.settings.depthOfField = true;
    this.world.bus.emit('settings:changed');
    setClass(this.root, 'on', true);
    for (const c of this.ctls) c.sync();
  }

  exit(): void {
    if (!this.active_) return;
    this.active_ = false;
    this.world.settings.depthOfField = this.prevDof;
    this.world.bus.emit('settings:changed');
    setClass(this.root, 'on', false);
  }

  toggle(): void {
    if (this.active_) this.exit();
    else this.enter();
  }

  applyOverrides(world: World): void {
    if (!this.active_) return;
    world.cam.focusDistance = this.focus;
  }
}
