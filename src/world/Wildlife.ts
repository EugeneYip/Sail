import type { Module, World } from '../types';
import { Birds } from './Birds';
import { Dolphins } from './Dolphins';
import { Vessels } from './Vessels';
import { Whales } from './Whales';

/**
 * The company. Everything alive or crewed that shares the sea with the player.
 *
 * APPEARANCE RATES. Each population runs an independent Poisson process: one
 * exponential draw per transition, never a per-frame roll and never a fixed
 * period. That matters. A memoryless process has no phase, so nothing ever
 * lines up into a rhythm, and the wait a player has already served tells them
 * nothing about the wait remaining — which is exactly the feeling of watching
 * the sea. Nominal means:
 *
 *   seabirds   ~3.5 min between flocks (a third of that within sight of land),
 *              each flock stays ~4.5 min. Present at boot.
 *   dolphins   ~4.5 min, gated on making more than 3.4 kn, ~1.2 min per pod.
 *   whales     ~15 min, ~2.5 min per encounter, 60 per cent of them distant.
 *   vessels    ~3.5 min between sails, up to three in company at once, each
 *              retiring past 12.5 km. One in four is an `overhaul`: put ahead
 *              of you making a knot less, so you spend minutes closing her.
 *
 * DETERMINISTIC REVIEW. Random is unreviewable, so every population also has a
 * forced entrance:
 *
 *   http://127.0.0.1:5178/?showcase=all
 *   world.bus.emit('world:showcase', 'dolphins')
 *
 * Accepted names: birds, dolphins, whales, whaleclose, vessels, boston, all,
 * and `near` — which is `all` with the whale and every hull type brought inside
 * 500 m, so a reviewer can judge the construction rather than a silhouette.
 * The URL form is what `scripts/capture.mjs --url` needs, since the harness
 * loads the page once and never reloads it.
 */
export class Wildlife implements Module {
  readonly name = 'wildlife';

  private birds = new Birds();
  private dolphins = new Dolphins();
  private whales = new Whales();
  private vessels = new Vessels();
  private pendingShowcase: string | null = null;
  private offSub: (() => void)[] = [];

  init(world: World): void {
    this.birds.init(world);
    this.dolphins.init(world);
    this.whales.init(world);
    this.vessels.init(world);

    let q: string | null = null;
    try {
      q = new URLSearchParams(location.search).get('showcase');
    } catch {
      /* no location in a worker or a test harness */
    }
    this.pendingShowcase = q;

    this.offSub.push(
      world.bus.on('world:showcase', (p) => {
        this.pendingShowcase = typeof p === 'string' ? p : 'all';
      }),
    );
  }

  applySettings(world: World): void {
    this.birds.applySettings(world);
    this.vessels.applySettings(world);
  }

  update(world: World): void {
    const t0 = performance.now();
    const dt = world.time.dt;

    // Wait for the solver to float the hull before placing anything relative to
    // it, or a showcase pod ends up where the ship was on frame one.
    if (this.pendingShowcase !== null && world.time.elapsed > 1.2) {
      this.runShowcase(world, this.pendingShowcase);
      this.pendingShowcase = null;
    }

    this.birds.update(world, dt);
    this.dolphins.update(world, dt);
    this.whales.update(world, dt);
    this.vessels.update(world, dt);

    world.stats['world.wildlifeMs'] = performance.now() - t0;
  }

  private runShowcase(world: World, which: string): void {
    const near = which === 'near';
    const all = near || which === 'all' || which === '1' || which === 'true';
    if (all || which === 'birds') this.birds.showcase(world);
    if (all || which === 'dolphins') this.dolphins.showcase();
    if (which === 'whales' || (all && !near)) this.whales.showcase(world, false);
    if (near || which === 'whaleclose') this.whales.showcase(world, true);
    if (near) this.vessels.showcaseNear(world);
    else if (all || which === 'vessels') this.vessels.showcase(world);
  }

  dispose(): void {
    for (const off of this.offSub) off();
    this.offSub.length = 0;
    this.birds.dispose();
    this.dolphins.dispose();
    this.whales.dispose();
    this.vessels.dispose();
  }
}
