# Leeward — Tall Ship Voyage

An endless, calm sailing game in the browser. You have the helm of the USS
Constitution — a 44-gun heavy frigate of 1797 — on an open procedural ocean.
Arrow keys, and somewhere to go.

Built with Three.js and WebGL2. **Everything is generated in code**: the ship,
the ocean, the sky, the textures and the audio. No downloaded models, images,
HDRIs or sound files. The whole game is a few hundred KB.

## Run it

```bash
npm ci
npm run dev          # http://127.0.0.1:5178
```

## Build

```bash
npm run typecheck    # GLSL lint + tsc
npm run build        # static bundle in dist/
```

`base` is `'./'`, so `dist/` can be served from any subpath — a GitHub Pages
project site included. There is no server component and nothing is fetched at
runtime.

## Controls

Arrow keys steer and set sail; sail trim is automatic in the default mode. Drag
to look around — you can look anywhere including forward over the bow. `C`
cycles camera modes. The `PRO` toggle in the corner swaps the minimal readout
for the full instrument HUD (compass ribbon, wind rose, sail plan diagram,
inclinometer, chart, watch bells) and hands you manual control of the rig.

## Verifying a change

```bash
node scripts/capture.mjs --out shots/x --scene all --settle 12 --console
```

Renders every scene headlessly with real GPU rasterisation and reports frame-period
percentiles. It refuses to print a timing when another headless renderer is
competing for the GPU, because load average cannot see GPU contention.

**Read `AGENTS.md` before changing anything** — it is the build contract. If you are
picking this project up cold, start with `HANDOVER.md`.

## Licence

Not yet chosen. Add one before publishing.
