#!/usr/bin/env node
/**
 * Self-test for `measure.mjs`. A harness that merely runs is worthless; this
 * demonstrates it catches the exact class of mistake that caused five retractions.
 *
 *   1. NULL      a lever that binds but cannot touch the channels measured
 *                (film grain vs ship speed) -> must be REJECTED, not "no effect
 *                found and therefore innocent".
 *   2. POSITIVE  a lever that binds and must show (wind speed vs ship speed)
 *                -> must be SIGNIFICANT.
 *   3. CONFOUND  identical no-op arms measured the OLD way, sharing one page load,
 *                against the same arms with a fresh load each. The control channel
 *                exposes the drift in the shared-load run.
 *
 * Control channel throughout is the sun's elevation. No physics or post arm can
 * move it, and its mean shifts if simulation time drifts between arms — which is
 * precisely the confound that produced the retracted results.
 *
 *   node scripts/measure-selftest.mjs
 */

import { measure, report } from './measure.mjs';
import process from 'node:process';

const SCENE = { timeOfDay: 12.3, windSpeed: 8, cloudCover: 0.3, turbidity: 2.2,
  rain: 0, visibility: 34000, seaState: 3, waveHeight: 1.3, choppiness: 0.5 };
const COMMON = { scene: SCENE, camera: { mode: 'chase', distance: 76 },
  width: 1024, height: 576, settleMs: 9000, warmFrames: 150, samples: 200,
  channels: ['speed', 'shipY', 'sunY'], control: ['sunY'], quiet: true,
  sample: (w) => ({
    speed: Math.hypot(w.ship.velocity?.x ?? 0, w.ship.velocity?.z ?? 0) * 1.94384,
    shipY: w.ship.position.y,
    sunY: w.env.sunDirection.y,
  }) };

let failures = 0;
const expect = (cond, msg) => {
  console.log(`    ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- 1. NULL
console.log('\n=== 1. NULL: film grain cannot move ship speed ===');
const nul = await measure({ ...COMMON, repeats: 3, dtPolicy: 'whole', arms: [
  { name: 'base', apply: null },
  { name: 'grain_off', apply: (w) => { w.settings.filmGrain = false;
      w.bus.emit('settings:changed');
      return { bound: w.settings.filmGrain === false }; } },
] });
report(nul);
expect(nul.bound.grain_off === true, 'null arm reported BOUND (the lever really applied)');
expect(nul.verdicts.grain_off.speed.verdict.startsWith('REJECTED'),
  'speed delta rejected as within control variance');
expect(nul.verdicts.grain_off.sunY.verdict.startsWith('REJECTED'),
  'control channel itself rejected');

// ------------------------------------------------------------ 2. POSITIVE
console.log('\n=== 2. POSITIVE: wind speed must move ship speed ===');
const pos = await measure({ ...COMMON, repeats: 3, dtPolicy: 'whole', arms: [
  { name: 'wind8', apply: null },
  { name: 'wind18', apply: (w) => { w.env.windSpeed = 18;
      return { bound: Math.abs(w.env.windSpeed - 18) < 1e-9 }; } },
] });
report(pos);
expect(pos.bound.wind18 === true, 'positive arm reported BOUND');
expect(pos.verdicts.wind18.speed.verdict === 'SIGNIFICANT',
  'speed delta detected as significant');
expect(pos.verdicts.wind18.sunY.verdict.startsWith('REJECTED'),
  'control channel unmoved by the wind arm (control is valid)');

// ------------------------------------------------------------ 3. CONFOUND
console.log('\n=== 3. CONFOUND: identical no-op arms, shared load vs fresh load ===');
const noopArms = ['a1', 'a2', 'a3'].map((n) => ({ name: n, apply: null }));
const shared = await measure({ ...COMMON, repeats: 2, dtPolicy: 'whole',
  freshLoadPerArm: false, arms: noopArms });
const fresh = await measure({ ...COMMON, repeats: 2, dtPolicy: 'whole',
  freshLoadPerArm: true, arms: noopArms });
const spread = (r) => r.controlFloor.sunY.acrossArms;
console.log(`    shared-load control spread across identical arms: ${spread(shared).toExponential(3)}`);
console.log(`    fresh-load  control spread across identical arms: ${spread(fresh).toExponential(3)}`);
expect(shared.warnings.some((w) => w.includes('freshLoadPerArm=false')),
  'shared-load run warned about drift');
expect(spread(shared) > spread(fresh),
  'shared load shows MORE control drift across identical arms than fresh loads');
// The decisive property: with identical arms, nothing may be reported significant.
const anySig = (r) => Object.values(r.verdicts)
  .some((chans) => Object.values(chans).some((v) => v.verdict === 'SIGNIFICANT'));
expect(!anySig(fresh), 'fresh-load run reports NO significant effect between identical arms');

// The concrete false conclusion, on the same data, under the error bar that was
// actually used before: within-run sd / sqrt(samples). That treats sample count as
// if it bought precision about a quantity whose real error is between RUNS. Applied
// to the CONTROL channel -- which no arm can influence -- it is self-evidently absurd.
const naiveSigma = (r, arm, c) => r.perArm[arm][c].sd / Math.sqrt(r.meta.samples);
const naiveZ = (r, c) => {
  const arms = Object.keys(r.perArm);
  const d = Math.max(...arms.map((n) => r.perArm[n][c].mean))
    - Math.min(...arms.map((n) => r.perArm[n][c].mean));
  return d / naiveSigma(r, arms[0], c);
};
const zShared = naiveZ(shared, 'sunY'), zFresh = naiveZ(fresh, 'sunY');
console.log(`    naive within-run z on the CONTROL channel, shared load: ${zShared.toFixed(1)} sigma`);
console.log(`    naive within-run z on the CONTROL channel, fresh loads: ${zFresh.toFixed(1)} sigma`);
expect(zShared > 10,
  'the old within-run error bar would declare a large effect on a channel nothing can affect');
expect(Object.values(shared.verdicts).every((ch) => ch.sunY.verdict.startsWith('REJECTED')),
  'the harness rejects it anyway, because the control floor absorbs the drift');
expect(zShared > zFresh * 3,
  'sharing one load inflates that spurious significance by a large factor over fresh loads');

console.log(`\n=== ${failures ? failures + ' CHECK(S) FAILED' : 'all checks passed'} ===`);
process.exit(failures ? 1 : 0);
