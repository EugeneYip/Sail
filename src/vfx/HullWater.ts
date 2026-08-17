import * as THREE from 'three';
import type { World } from '../types';
import { HULL } from './Context';
import type { VfxCtx } from './Context';
import { hullSkirtFrag, hullSkirtVert, hullWaterFrag, hullWaterVert } from './shaders/hullwater';
import type { WaterProbe } from './WaterProbe';

const SHEET_STATIONS = 44;
const SHEET_ACROSS = 9;
const PAD_STATIONS = 15;
const PAD_ACROSS = 15;
const SKIRT_STATIONS = 40;
const SKIRT_ROWS = 6;

const _p = new THREE.Vector3();
const _invShip = new THREE.Matrix4();

/**
 * The bow wave, quarter wave, transom pad and wetted-hull skirt. Two draw
 * calls, both parented to `shipRoot`.
 */
export class HullWater {
  private sheet!: THREE.Mesh;
  private skirt!: THREE.Mesh;
  private sheetMat!: THREE.RawShaderMaterial;
  private skirtMat!: THREE.RawShaderMaterial;
  private waterPort = new THREE.Vector3();
  private waterStbd = new THREE.Vector3();

  init(world: World, foamTex: THREE.Texture): void {
    const lwl = HULL.lwl;

    this.sheetMat = new THREE.RawShaderMaterial({
      uniforms: {
        ...world.uniforms,
        tFoam: { value: foamTex },
        uBeam: { value: world.ship.beam },
        uLwl: { value: lwl },
        uSpeed: { value: 0 },
        uSpeedN: { value: 0 },
        uHeel: { value: 0 },
        uRudder: { value: 0 },
        uSlam: { value: 0 },
        uChop: { value: 0.5 },
        uOpacity: { value: 1 },
        uWaterPort: { value: this.waterPort },
        uWaterStbd: { value: this.waterStbd },
      },
      vertexShader: hullWaterVert,
      fragmentShader: hullWaterFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    this.skirtMat = new THREE.RawShaderMaterial({
      uniforms: {
        ...world.uniforms,
        tFoam: { value: foamTex },
        uBeam: { value: world.ship.beam },
        uLwl: { value: lwl },
        uSpeed: { value: 0 },
        uSpeedN: { value: 0 },
        uHeel: { value: 0 },
        uRudder: { value: 0 },
        uSlam: { value: 0 },
        uChop: { value: 0.5 },
        uOpacity: { value: 1 },
        uSkirtLow: { value: -1.7 },
        uSkirtHigh: { value: 3.4 },
        uWaterPort: { value: this.waterPort },
        uWaterStbd: { value: this.waterStbd },
      },
      vertexShader: hullSkirtVert,
      fragmentShader: hullSkirtFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    this.sheet = new THREE.Mesh(this.buildSheet(), this.sheetMat);
    this.sheet.frustumCulled = false;
    this.sheet.renderOrder = 6;
    this.sheet.name = 'vfx-bow-wave';
    world.shipRoot.add(this.sheet);

    this.skirt = new THREE.Mesh(this.buildSkirt(), this.skirtMat);
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = 5;
    this.skirt.name = 'vfx-hull-skirt';
    world.shipRoot.add(this.skirt);
  }

  /** Bow/quarter sheet (both sides) plus the transom pad, in one geometry. */
  private buildSheet(): THREE.BufferGeometry {
    const sheetVerts = 2 * SHEET_STATIONS * SHEET_ACROSS;
    const padVerts = PAD_STATIONS * PAD_ACROSS;
    const total = sheetVerts + padVerts;
    const pos = new Float32Array(total * 3);
    const part = new Float32Array(total);
    const idx: number[] = [];

    let v = 0;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const base = v;
      for (let i = 0; i < SHEET_STATIONS; i++) {
        // Bunch stations forward where the crest lives.
        const ti = i / (SHEET_STATIONS - 1);
        const t = Math.pow(ti, 1.45);
        for (let j = 0; j < SHEET_ACROSS; j++) {
          pos[v * 3] = t;
          pos[v * 3 + 1] = j / (SHEET_ACROSS - 1);
          pos[v * 3 + 2] = side;
          part[v] = 0;
          v++;
        }
      }
      for (let i = 0; i < SHEET_STATIONS - 1; i++) {
        for (let j = 0; j < SHEET_ACROSS - 1; j++) {
          const a = base + i * SHEET_ACROSS + j;
          idx.push(a, a + SHEET_ACROSS, a + 1, a + 1, a + SHEET_ACROSS, a + SHEET_ACROSS + 1);
        }
      }
    }

    const padBase = v;
    for (let i = 0; i < PAD_STATIONS; i++) {
      const t = Math.pow(i / (PAD_STATIONS - 1), 1.2);
      for (let j = 0; j < PAD_ACROSS; j++) {
        pos[v * 3] = t;
        pos[v * 3 + 1] = (j / (PAD_ACROSS - 1)) * 2 - 1;
        pos[v * 3 + 2] = 1;
        part[v] = 1;
        v++;
      }
    }
    for (let i = 0; i < PAD_STATIONS - 1; i++) {
      for (let j = 0; j < PAD_ACROSS - 1; j++) {
        const a = padBase + i * PAD_ACROSS + j;
        idx.push(a, a + PAD_ACROSS, a + 1, a + 1, a + PAD_ACROSS, a + PAD_ACROSS + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    geo.setIndex(idx);
    return geo;
  }

  private buildSkirt(): THREE.BufferGeometry {
    const total = 2 * SKIRT_STATIONS * SKIRT_ROWS;
    const pos = new Float32Array(total * 3);
    const idx: number[] = [];
    let v = 0;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const base = v;
      for (let i = 0; i < SKIRT_STATIONS; i++) {
        const t = 0.012 + (i / (SKIRT_STATIONS - 1)) * 0.976;
        for (let r = 0; r < SKIRT_ROWS; r++) {
          pos[v * 3] = t;
          pos[v * 3 + 1] = r / (SKIRT_ROWS - 1);
          pos[v * 3 + 2] = side;
          v++;
        }
      }
      for (let i = 0; i < SKIRT_STATIONS - 1; i++) {
        for (let r = 0; r < SKIRT_ROWS - 1; r++) {
          const a = base + i * SKIRT_ROWS + r;
          idx.push(a, a + SKIRT_ROWS, a + 1, a + 1, a + SKIRT_ROWS, a + SKIRT_ROWS + 1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
  }

  update(ctx: VfxCtx, probe: WaterProbe): void {
    const world = ctx.world;
    const lwl = HULL.lwl;
    const beam = world.ship.beam;

    // Convert the real sea surface at six stations into ship-local Y so the
    // sheet and the boot top ride the actual water, not y = 0.
    _invShip.copy(ctx.shipMatrix).invert();
    const stations: [number, THREE.Vector3][] = [
      [-1, this.waterPort],
      [1, this.waterStbd],
    ];
    for (const [side, out] of stations) {
      for (let k = 0; k < 3; k++) {
        const t = k * 0.5;
        const hb = ctx.halfBeam(t) * 0.9;
        _p.set(side * hb, 0, t * lwl - lwl * 0.5).applyMatrix4(ctx.shipMatrix);
        _p.y = probe.heightAt(_p.x, _p.z);
        _p.applyMatrix4(_invShip);
        out.setComponent(k, _p.y);
      }
    }

    const visible = ctx.speedN > 0.012;
    this.sheet.visible = visible;
    this.skirt.visible = visible || ctx.wetness > 0.05;

    for (const m of [this.sheetMat, this.skirtMat]) {
      const u = m.uniforms;
      u.uSpeed.value = ctx.speed;
      u.uSpeedN.value = ctx.speedN;
      u.uHeel.value = ctx.heel;
      u.uRudder.value = ctx.rudder;
      u.uSlam.value = ctx.slam;
      u.uChop.value = world.env.choppiness;
      u.uBeam.value = beam;
    }
    this.skirtMat.uniforms.uSkirtHigh.value = 2.6 + ctx.speedN * 2.2;
  }

  applySettings(): void {}

  dispose(): void {
    this.sheet.geometry.dispose();
    this.skirt.geometry.dispose();
    this.sheetMat.dispose();
    this.skirtMat.dispose();
    this.sheet.removeFromParent();
    this.skirt.removeFromParent();
  }
}
