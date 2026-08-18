import * as THREE from 'three';
import { SkyPass } from './Pass';
import { MOON_TEXTURE_FRAG } from './shaders/celestial';
import { kelvinToColor } from '../util/math';

const MOON_W = 256;
const MOON_H = 128;

/**
 * Lunar albedo map, baked once into a 256x128 equirect. Wraps in longitude so
 * the limb has no seam; clamps in latitude so the poles do not smear.
 */
export function bakeMoonAlbedo(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(MOON_W, MOON_H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  const pass = new SkyPass(MOON_TEXTURE_FRAG, {});
  pass.render(renderer, rt);
  pass.dispose();
  return rt;
}

/**
 * Stellar colour ramp, 64x1 linear RGB.
 *
 * The naked-eye sky is not a uniform draw from the stellar temperature
 * distribution — M dwarfs dominate by count but none are visible, while the
 * rare B and A giants are over-represented among bright stars. These stops are
 * roughly the observed spectral-class histogram of stars brighter than mag 5:
 * ~40% K/M, ~30% F/G, ~30% B/A.
 */
const STAR_TEMPERATURE_STOPS: Array<[number, number]> = [
  [0.0, 2900],
  [0.18, 3700],
  [0.4, 4900],
  [0.55, 5800],
  [0.7, 6700],
  [0.82, 8600],
  [0.92, 12500],
  [1.0, 22000],
];

export function makeStarRamp(): THREE.DataTexture {
  const n = 64;
  const data = new Float32Array(n * 4);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    let k = STAR_TEMPERATURE_STOPS[0][1];
    for (let s = 1; s < STAR_TEMPERATURE_STOPS.length; s++) {
      const [ua, ka] = STAR_TEMPERATURE_STOPS[s - 1];
      const [ub, kb] = STAR_TEMPERATURE_STOPS[s];
      if (u <= ub) {
        k = ka + ((u - ua) / (ub - ua)) * (kb - ka);
        break;
      }
      k = kb;
    }
    kelvinToColor(k, c);
    // Normalise to unit luminance: a star's colour must not change how bright
    // its magnitude makes it, or every red star would vanish.
    const lum = Math.max(1e-4, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    data[i * 4 + 0] = c.r / lum;
    data[i * 4 + 1] = c.g / lum;
    data[i * 4 + 2] = c.b / lum;
    data[i * 4 + 3] = 1;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 1x1 white texture used as a stand-in before the cloud shadow map exists. */
export function makeWhitePixel(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}
