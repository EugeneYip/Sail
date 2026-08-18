import * as THREE from 'three';
import {
  ATMOSPHERE_TOP_KM,
  GROUND_ALBEDO,
  GROUND_RADIUS_KM,
  MIE_ABSORPTION,
  MIE_ANISOTROPY,
  MIE_SCALE_HEIGHT_KM,
  MIE_SCATTERING,
  OZONE_ABSORPTION,
  OZONE_CENTRE_KM,
  OZONE_HALF_WIDTH_KM,
  RAYLEIGH_SCALE_HEIGHT_KM,
  RAYLEIGH_SCATTERING,
} from './constants';

const RG = GROUND_RADIUS_KM;
const RT = ATMOSPHERE_TOP_KM;
const INV_4PI = 1 / (4 * Math.PI);

const T_MU = 64;
const T_ALT = 32;

/** Directions used to estimate the direction-averaged isotropic scattering. */
const MS_DIRS: Array<[number, number, number]> = [
  [0, 1, 0],
  [0, -1, 0],
  [0.894, 0.447, 0],
  [-0.894, 0.447, 0],
  [0, 0.447, 0.894],
  [0, 0.447, -0.894],
  [0.707, -0.707, 0],
  [0, -0.707, 0.707],
];

/**
 * A compact CPU mirror of the GPU atmosphere. It exists because the sun's light
 * colour, the ambient/fog colours and the star-visibility thresholds all have to
 * be known on the CPU, and a GPU readback would either stall the pipeline or
 * arrive two frames late. Same constants, same integrator shape as
 * `shaders/atmosphere.ts`, so the directional light always agrees with the sky
 * it is standing under.
 *
 * All returned radiance is in model units (top-of-atmosphere solar irradiance
 * = 1). Callers apply RADIANCE_SCALE.
 */
export class AtmosphereCpu {
  /** Transmittance table, Bruneton (mu, r) parameterisation, RGB. */
  private table = new Float32Array(T_MU * T_ALT * 3);
  private bakedMieMul = -1;

  private scratchT = new THREE.Vector3();
  private scratchP = new THREE.Vector3();
  private msAvg = new THREE.Vector3();
  private msFms = new THREE.Vector3();

  /**
   * Rebuild the transmittance table. Several ms of JS, so the caller is
   * responsible for only moving `mieMul` on a material aerosol change — see the
   * deadband in `Radiometry.update`.
   */
  bake(mieMul: number): void {
    if (Math.abs(mieMul - this.bakedMieMul) < 1e-3) return;
    this.bakedMieMul = mieMul;
    const t = this.table;
    let i = 0;
    for (let ai = 0; ai < T_ALT; ai++) {
      const v = (ai + 0.5) / T_ALT;
      for (let mi = 0; mi < T_MU; mi++) {
        const u = (mi + 0.5) / T_MU;
        const { r, mu } = paramsFromUv(u, v);
        opticalDepth(r, mu, mieMul, this.scratchT);
        t[i++] = Math.exp(-this.scratchT.x);
        t[i++] = Math.exp(-this.scratchT.y);
        t[i++] = Math.exp(-this.scratchT.z);
      }
    }
  }

  /** Bilinear table fetch of transmittance from radius r along cos-zenith mu. */
  transmittance(r: number, mu: number, out: THREE.Vector3): THREE.Vector3 {
    const H = Math.sqrt(Math.max(0, RT * RT - RG * RG));
    const rho = Math.sqrt(Math.max(0, r * r - RG * RG));
    const d = Math.max(0, -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + RT * RT)));
    const dMin = RT - r;
    const dMax = rho + H;
    const u = THREE.MathUtils.clamp((d - dMin) / Math.max(1e-5, dMax - dMin), 0, 1);
    const v = THREE.MathUtils.clamp(rho / H, 0, 1);

    const fx = u * T_MU - 0.5;
    const fy = v * T_ALT - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const cx0 = THREE.MathUtils.clamp(x0, 0, T_MU - 1);
    const cx1 = THREE.MathUtils.clamp(x0 + 1, 0, T_MU - 1);
    const cy0 = THREE.MathUtils.clamp(y0, 0, T_ALT - 1);
    const cy1 = THREE.MathUtils.clamp(y0 + 1, 0, T_ALT - 1);
    const t = this.table;
    out.set(0, 0, 0);
    for (let c = 0; c < 3; c++) {
      const a = t[(cy0 * T_MU + cx0) * 3 + c];
      const b = t[(cy0 * T_MU + cx1) * 3 + c];
      const d0 = t[(cy1 * T_MU + cx0) * 3 + c];
      const e = t[(cy1 * T_MU + cx1) * 3 + c];
      const top = a + (b - a) * tx;
      const bot = d0 + (e - d0) * tx;
      const val = top + (bot - top) * ty;
      if (c === 0) out.x = val;
      else if (c === 1) out.y = val;
      else out.z = val;
    }
    return out;
  }

  /**
   * Estimate the isotropic multiple-scattering term at the observer's altitude,
   * the same quantity the GPU bakes into the 32x32 LUT: the direction average of
   * the second-order isotropic scattering, closed by the geometric series.
   * Must be called before `radiance()` each frame.
   */
  updateMultiScatter(camAltKm: number, sunMu: number, mieMul: number): void {
    const r0 = RG + camAltKm;
    const sunH = Math.sqrt(Math.max(0, 1 - sunMu * sunMu));
    this.msAvg.set(0, 0, 0);
    this.msFms.set(0, 0, 0);
    const steps = 10;
    for (const dir of MS_DIRS) {
      const dy = dir[1];
      const p = this.scratchP;
      let tr = 1;
      let tg = 1;
      let tb = 1;
      const tGround = raySphereNear(0, r0, 0, dir[0], dy, dir[2], RG);
      const tTop = raySphereFar(0, r0, 0, dir[0], dy, dir[2], RT);
      const tMax = tGround > 0 ? tGround : tTop;
      if (tMax <= 0) continue;
      const dt = tMax / steps;
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) * dt;
        p.set(dir[0] * t, r0 + dy * t, dir[2] * t);
        const rr = p.length();
        const h = rr - RG;
        const dR = Math.exp(-Math.max(0, h) / RAYLEIGH_SCALE_HEIGHT_KM);
        const dM = Math.exp(-Math.max(0, h) / MIE_SCALE_HEIGHT_KM) * mieMul;
        const dO = Math.max(0, 1 - Math.abs(h - OZONE_CENTRE_KM) / OZONE_HALF_WIDTH_KM);
        const sR = RAYLEIGH_SCATTERING.x * dR;
        const sG = RAYLEIGH_SCATTERING.y * dR;
        const sB = RAYLEIGH_SCATTERING.z * dR;
        const sM = MIE_SCATTERING * dM;
        const eR = sR + sM + MIE_ABSORPTION * dM + OZONE_ABSORPTION.x * dO;
        const eG = sG + sM + MIE_ABSORPTION * dM + OZONE_ABSORPTION.y * dO;
        const eB = sB + sM + MIE_ABSORPTION * dM + OZONE_ABSORPTION.z * dO;

        const muSunHere = (p.x * sunH + p.y * sunMu) / rr;
        const shadow = raySphereNear(p.x, p.y, p.z, sunH, sunMu, 0, RG) > 0 ? 0 : 1;
        this.transmittance(rr, muSunHere, this.scratchT);

        const w = dt * INV_4PI * shadow;
        this.msAvg.x += tr * (sR + sM) * this.scratchT.x * w;
        this.msAvg.y += tg * (sG + sM) * this.scratchT.y * w;
        this.msAvg.z += tb * (sB + sM) * this.scratchT.z * w;
        this.msFms.x += tr * (sR + sM) * dt;
        this.msFms.y += tg * (sG + sM) * dt;
        this.msFms.z += tb * (sB + sM) * dt;

        tr *= Math.exp(-eR * dt);
        tg *= Math.exp(-eG * dt);
        tb *= Math.exp(-eB * dt);
      }
    }
    const n = MS_DIRS.length;
    this.msAvg.multiplyScalar(1 / n);
    this.msFms.multiplyScalar(1 / n);
    this.msAvg.x /= Math.max(1e-3, 1 - Math.min(0.95, this.msFms.x));
    this.msAvg.y /= Math.max(1e-3, 1 - Math.min(0.95, this.msFms.y));
    this.msAvg.z /= Math.max(1e-3, 1 - Math.min(0.95, this.msFms.z));
  }

  /**
   * Sky radiance looking along a direction with vertical component `dirY` whose
   * angle to the sun has cosine `cosTheta`. Single scattering with phase plus the
   * isotropic multiple-scattering term from `updateMultiScatter`.
   */
  radiance(
    dirY: number,
    cosTheta: number,
    camAltKm: number,
    sunMu: number,
    mieMul: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const r0 = RG + camAltKm;
    const dirH = Math.sqrt(Math.max(0, 1 - dirY * dirY));
    const sunH = Math.sqrt(Math.max(0, 1 - sunMu * sunMu));

    const tGround = raySphereNear(0, r0, 0, dirH, dirY, 0, RG);
    const tTop = raySphereFar(0, r0, 0, dirH, dirY, 0, RT);
    const hitsGround = tGround > 0;
    const tMax = hitsGround ? tGround : tTop;
    out.set(0, 0, 0);
    if (tMax <= 0) return out;

    const pR = (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
    const g = MIE_ANISOTROPY;
    const g2 = g * g;
    const kM = ((3 / (8 * Math.PI)) * (1 - g2)) / (2 + g2);
    const dM0 = Math.max(1e-4, 1 + g2 - 2 * g * cosTheta);
    const pM = (kM * (1 + cosTheta * cosTheta)) / (dM0 * Math.sqrt(dM0));

    const steps = 24;
    const dt = tMax / steps;
    let tr = 1;
    let tg = 1;
    let tb = 1;
    const p = this.scratchP;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * dt;
      p.set(dirH * t, r0 + dirY * t, 0);
      const rr = p.length();
      const h = rr - RG;
      const dR = Math.exp(-Math.max(0, h) / RAYLEIGH_SCALE_HEIGHT_KM);
      const dMi = Math.exp(-Math.max(0, h) / MIE_SCALE_HEIGHT_KM) * mieMul;
      const dO = Math.max(0, 1 - Math.abs(h - OZONE_CENTRE_KM) / OZONE_HALF_WIDTH_KM);
      const sR = RAYLEIGH_SCATTERING.x * dR;
      const sG = RAYLEIGH_SCATTERING.y * dR;
      const sB = RAYLEIGH_SCATTERING.z * dR;
      const sM = MIE_SCATTERING * dMi;
      const eR = sR + sM + MIE_ABSORPTION * dMi + OZONE_ABSORPTION.x * dO;
      const eG = sG + sM + MIE_ABSORPTION * dMi + OZONE_ABSORPTION.y * dO;
      const eB = sB + sM + MIE_ABSORPTION * dMi + OZONE_ABSORPTION.z * dO;

      const upY = p.y / rr;
      const upH = p.x / rr;
      const muSunHere = upY * sunMu + upH * sunH;
      const shadow = raySphereNear(p.x, p.y, p.z, sunH, sunMu, 0, RG) > 0 ? 0 : 1;
      this.transmittance(rr, muSunHere, this.scratchT);

      const direct = dt * shadow;
      out.x += tr * (sR * pR + sM * pM) * this.scratchT.x * direct;
      out.y += tg * (sG * pR + sM * pM) * this.scratchT.y * direct;
      out.z += tb * (sB * pR + sM * pM) * this.scratchT.z * direct;
      out.x += tr * (sR + sM) * this.msAvg.x * dt;
      out.y += tg * (sG + sM) * this.msAvg.y * dt;
      out.z += tb * (sB + sM) * this.msAvg.z * dt;

      tr *= Math.exp(-eR * dt);
      tg *= Math.exp(-eG * dt);
      tb *= Math.exp(-eB * dt);
    }

    if (hitsGround && sunMu > 0) {
      this.transmittance(RG, sunMu, this.scratchT);
      out.x += tr * this.scratchT.x * sunMu * GROUND_ALBEDO.x / Math.PI;
      out.y += tg * this.scratchT.y * sunMu * GROUND_ALBEDO.y / Math.PI;
      out.z += tb * this.scratchT.z * sunMu * GROUND_ALBEDO.z / Math.PI;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 *  helpers — kept module-private and allocation-free
 * ------------------------------------------------------------------ */

function paramsFromUv(u: number, v: number): { r: number; mu: number } {
  const H = Math.sqrt(Math.max(0, RT * RT - RG * RG));
  const rho = H * v;
  const r = Math.sqrt(rho * rho + RG * RG);
  const dMin = RT - r;
  const dMax = rho + H;
  const d = dMin + u * (dMax - dMin);
  const mu = d === 0 ? 1 : THREE.MathUtils.clamp((H * H - rho * rho - d * d) / (2 * r * d), -1, 1);
  return { r, mu };
}

function opticalDepth(r: number, mu: number, mieMul: number, out: THREE.Vector3): void {
  const dirH = Math.sqrt(Math.max(0, 1 - mu * mu));
  const tGround = raySphereNear(0, r, 0, dirH, mu, 0, RG);
  const tTop = raySphereFar(0, r, 0, dirH, mu, 0, RT);
  const tMax = tGround > 0 ? tGround : tTop;
  out.set(0, 0, 0);
  if (tMax <= 0) return;
  // 24 steps, not 40: this integrand is monotone and smooth, the table is only a
  // mirror of a GPU LUT that is itself sampled bilinearly, and the bake is the
  // single most expensive piece of CPU work the sky does.
  const steps = 24;
  const dt = tMax / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const px = dirH * t;
    const py = r + mu * t;
    const rr = Math.sqrt(px * px + py * py);
    const h = Math.max(0, rr - RG);
    const dR = Math.exp(-h / RAYLEIGH_SCALE_HEIGHT_KM);
    const dM = Math.exp(-h / MIE_SCALE_HEIGHT_KM) * mieMul;
    const dO = Math.max(0, 1 - Math.abs(h - OZONE_CENTRE_KM) / OZONE_HALF_WIDTH_KM);
    const mieExt = (MIE_SCATTERING + MIE_ABSORPTION) * dM;
    out.x += (RAYLEIGH_SCATTERING.x * dR + mieExt + OZONE_ABSORPTION.x * dO) * dt;
    out.y += (RAYLEIGH_SCATTERING.y * dR + mieExt + OZONE_ABSORPTION.y * dO) * dt;
    out.z += (RAYLEIGH_SCATTERING.z * dR + mieExt + OZONE_ABSORPTION.z * dO) * dt;
  }
}

function raySphereNear(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  radius: number,
): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t1 < 0) return -1;
  return t0 < 0 ? t1 : t0;
}

function raySphereFar(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  radius: number,
): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}
