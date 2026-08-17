import type { QualityTier, Settings } from '../types';

const STORAGE_KEY = 'leeward.settings.v1';

export function defaultSettings(): Settings {
  return {
    quality: 'high',
    maxPixelRatio: 2,
    renderScale: 1,
    oceanResolution: 256,
    oceanCascades: 3,
    shadowMapSize: 2048,
    shadowCascades: 3,
    volumetricClouds: true,
    cloudSteps: 48,
    screenSpaceReflections: true,
    bloom: true,
    depthOfField: true,
    motionBlur: true,
    filmGrain: true,
    chromaticAberration: true,
    lensDirt: true,
    vignette: true,
    antialias: 'taa',
    propDensity: 1,
    particleDensity: 1,
    fov: 58,
    exposureBias: 0,
    autoExposure: true,
    masterVolume: 0.8,
    musicVolume: 0.45,
    adaptiveResolution: true,
    targetFps: 60,
    showHud: true,
    debug: false,
  };
}

type Preset = Partial<Settings>;

export const QUALITY_PRESETS: Record<QualityTier, Preset> = {
  low: {
    maxPixelRatio: 1,
    oceanResolution: 128,
    oceanCascades: 2,
    shadowMapSize: 1024,
    shadowCascades: 2,
    volumetricClouds: false,
    cloudSteps: 20,
    screenSpaceReflections: false,
    depthOfField: false,
    motionBlur: false,
    lensDirt: false,
    antialias: 'fxaa',
    propDensity: 0.4,
    particleDensity: 0.35,
  },
  medium: {
    maxPixelRatio: 1.25,
    oceanResolution: 256,
    oceanCascades: 2,
    shadowMapSize: 1536,
    shadowCascades: 3,
    volumetricClouds: true,
    cloudSteps: 32,
    screenSpaceReflections: false,
    depthOfField: true,
    motionBlur: true,
    lensDirt: true,
    antialias: 'smaa',
    propDensity: 0.7,
    particleDensity: 0.7,
  },
  high: {
    maxPixelRatio: 1.75,
    oceanResolution: 256,
    oceanCascades: 3,
    shadowMapSize: 2048,
    shadowCascades: 3,
    volumetricClouds: true,
    cloudSteps: 48,
    screenSpaceReflections: true,
    depthOfField: true,
    motionBlur: true,
    lensDirt: true,
    antialias: 'taa',
    propDensity: 1,
    particleDensity: 1,
  },
  ultra: {
    maxPixelRatio: 2,
    oceanResolution: 512,
    oceanCascades: 4,
    shadowMapSize: 4096,
    shadowCascades: 4,
    volumetricClouds: true,
    cloudSteps: 80,
    screenSpaceReflections: true,
    depthOfField: true,
    motionBlur: true,
    lensDirt: true,
    antialias: 'taa',
    propDensity: 1.4,
    particleDensity: 1.5,
  },
};

export function applyQualityPreset(settings: Settings, tier: QualityTier): void {
  Object.assign(settings, QUALITY_PRESETS[tier]);
  settings.quality = tier;
}

/** Rough device capability sniff, used only for the first-run default. */
export function guessQuality(renderer: { getContext(): WebGL2RenderingContext | WebGLRenderingContext }): QualityTier {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const info = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const s = info.toLowerCase();
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);

  if (mobile) return 'low';
  // Apple Silicon and recent discrete parts handle ultra comfortably.
  if (/apple m[2-9]|rtx (40|50)|rx 7[89]/.test(s)) return 'ultra';
  if (/apple m1|rtx (20|30)|rx (5|6)[6-9]|arc a/.test(s)) return 'high';
  if (/intel|uhd|iris|vega \d/.test(s)) return 'medium';
  return cores >= 8 ? 'high' : 'medium';
}

export function loadSettings(): Settings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(base, JSON.parse(raw) as Partial<Settings>);
  } catch {
    /* ignore corrupt storage */
  }
  // Never persist adaptive state.
  base.renderScale = 1;
  return base;
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage may be unavailable */
  }
}
