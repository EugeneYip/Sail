import './ui/styles.css';

import { Engine } from './core/Engine';
import { PostProcessing } from './core/PostProcessing';
import { InputSystem } from './input/Input';

import { createEnvModules } from './env';
import { createOceanModules } from './ocean';
import { createPhysicsModules } from './physics';
import { createShipModules } from './ship';
import { createSkyModules } from './sky';
import { createWorldModules } from './world';
import { createVfxModules } from './vfx';
import { createCameraModules } from './camera';
import { createAudioModules } from './audio';
import { createUiModules } from './ui';

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const engine = new Engine(canvas);

  const input = new InputSystem();
  input.bind(engine.world.input);

  /**
   * Registration order IS the update order. Each subsystem owns its own factory
   * so adding an internal module never touches this file.
   *
   *   input -> environment -> ocean -> physics -> ship visuals -> sky
   *   -> world -> vfx -> camera -> audio -> ui
   *
   * Ordering rationale:
   *   env before ocean   — wave spectrum depends on this frame's wind
   *   ocean before physics — buoyancy samples this frame's surface
   *   physics before ship  — visuals follow the solved body
   *   ship before sky      — shadow cascades need the final ship bounds
   *   everything before camera — the rig follows the settled ship
   *   camera before ui     — the HUD reads camera state
   */
  engine.use(
    input,
    ...createEnvModules(),
    ...createOceanModules(),
    ...createPhysicsModules(),
    ...createShipModules(),
    ...createSkyModules(),
    ...createWorldModules(),
    ...createVfxModules(),
    ...createCameraModules(),
    ...createAudioModules(),
    ...createUiModules(),
  );

  engine.setRenderHook(new PostProcessing(engine.world));

  await engine.init();
  engine.start();

  // Handle used by scripts/capture.mjs and by the browser console.
  (window as unknown as { __leeward: Engine }).__leeward = engine;
}

boot().catch((err) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:fixed;inset:0;margin:0;padding:24px;color:#ff9a9a;background:#0a0f14;font:12px/1.5 monospace;white-space:pre-wrap;z-index:9999;overflow:auto';
  pre.textContent = `Boot failed\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(pre);
});
