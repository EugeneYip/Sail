import type { World } from '../types';

/**
 * Where the cameras bolt onto the ship.
 *
 * The camera module cannot see the ship's geometry, so these are the historical
 * USS Constitution figures, in ship-local metres (+X starboard, +Y up,
 * -Z forward). The ship agent can override any of them by publishing an
 * `ext.ship` object with the same field names — see `readAnatomy` — which is the
 * intended cooperation path if their model ends up dimensioned differently.
 */
export interface ShipAnatomy {
  /** Spar (upper) deck height above the waterline. */
  deckY: number;
  /** Top of the bulwark / hammock netting above the waterline. */
  bulwarkY: number;
  /** Helmsman's eye, standing abaft the wheel on the quarterdeck. */
  helmX: number;
  helmY: number;
  helmZ: number;
  /** Centre of the wheel — what the helm view must keep in frame. */
  wheelY: number;
  wheelZ: number;
  /** A seat on the jibboom, inboard of the tip so the spar reads as foreground. */
  jibboomX: number;
  jibboomY: number;
  jibboomZ: number;
  /** The main top / topmast crosstrees platform. */
  mainTopX: number;
  mainTopY: number;
  mainTopZ: number;
  /** Mainmast station and truck height. */
  mainMastZ: number;
  mastheadY: number;
  /** Main yard height and half span, for the cinematic yard shot. */
  mainYardY: number;
  mainYardHalfSpan: number;
  /** Stem head, i.e. the top of the bow. */
  bowY: number;
  bowZ: number;
  /** Taffrail height and station. */
  sternY: number;
  sternZ: number;
}

export function defaultAnatomy(): ShipAnatomy {
  return {
    deckY: 5.2,
    bulwarkY: 7.6,
    // Wheel is just forward of the mizzen at the fore end of the quarterdeck;
    // the helmsman stands abaft it, so the eye is aft of and above the wheel.
    helmX: 0,
    helmY: 7.0,
    helmZ: 14.4,
    wheelY: 6.1,
    wheelZ: 12.0,
    // Bowsprit steeves up at ~20 deg from the stem head; the jibboom carries on
    // to make the 62 m LOA. Sit 4 m inboard of the tip.
    jibboomX: 0.9,
    jibboomY: 9.6,
    jibboomZ: -30.5,
    // Main top is at the lower-mast/topmast junction; go a little higher to the
    // crosstrees for real vertigo, offset off the mast axis to clear the rigging.
    mainTopX: 2.2,
    mainTopY: 38,
    mainTopZ: -0.4,
    mainMastZ: -2,
    mastheadY: 67,
    mainYardY: 23.5,
    mainYardHalfSpan: 20.5,
    bowY: 7.4,
    bowZ: -26.6,
    sternY: 8.2,
    sternZ: 26.6,
  };
}

/**
 * Merge any numeric overrides the ship agent publishes on `world.ext.ship`.
 * Unknown keys are ignored, so this is safe against whatever else they put
 * there. Cheap enough to re-run once a second in case they publish late.
 */
export function readAnatomy(world: World, into: ShipAnatomy): void {
  const src = world.ext.ship as Partial<Record<keyof ShipAnatomy, unknown>> | undefined;
  if (!src) return;
  for (const key in into) {
    const v = src[key as keyof ShipAnatomy];
    if (typeof v === 'number' && Number.isFinite(v)) into[key as keyof ShipAnatomy] = v;
  }
}
