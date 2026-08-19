import type { World } from '../types';

export type HudMode = 'minimal' | 'pro';

/**
 * One switch, two owners.
 *
 * The UI owns `settings.hudMode`. The handling layer owns whatever it ends up
 * calling its assist flag — that field did not exist when this was written, so
 * rather than importing a name we probe for one at runtime and mirror the two
 * in both directions. `minimal` means assisted, `pro` means the bare solver.
 *
 * Everything here is duck-typed and null-safe on purpose: if the handling agent
 * never lands a flag, the UI still switches cleanly on its own.
 */

/** Assist-sense flags: true means assisted, i.e. minimal. */
const ASSIST_KEYS = [
  'assist', 'assistMode', 'assists', 'sailAssist', 'handlingAssist', 'autoTrim', 'arcade',
];
/** Pro-sense flags: true means pro. */
const PRO_KEYS = ['proMode', 'proPhysics', 'proHandling', 'pro', 'expert'];

type Bag = Record<string, unknown>;

function bags(world: World): Bag[] {
  const out: Bag[] = [world.settings as unknown as Bag];
  const phys = world.ext.physics as Bag | null | undefined;
  if (phys && typeof phys === 'object') out.push(phys);
  return out;
}

/**
 * The mode implied by the handling layer's own flag, or null when it has not
 * published one. Settings win over `ext.physics` — a persisted setting is the
 * player's choice, the ext handle is only a mirror of it.
 */
export function readExternalMode(world: World): HudMode | null {
  for (const bag of bags(world)) {
    for (const k of ASSIST_KEYS) {
      if (typeof bag[k] === 'boolean') return bag[k] ? 'minimal' : 'pro';
    }
    for (const k of PRO_KEYS) {
      if (typeof bag[k] === 'boolean') return bag[k] ? 'pro' : 'minimal';
    }
  }
  return null;
}

/** Push our mode onto every assist flag that exists. No-op if none do. */
export function writeExternalMode(world: World, mode: HudMode): void {
  for (const bag of bags(world)) {
    for (const k of ASSIST_KEYS) {
      if (typeof bag[k] === 'boolean') bag[k] = mode === 'minimal';
    }
    for (const k of PRO_KEYS) {
      if (typeof bag[k] === 'boolean') bag[k] = mode === 'pro';
    }
  }
}
