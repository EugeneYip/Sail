import * as THREE from 'three';
import type { World } from '../types';
import { SHADOW_PULLBACK_M, SHADOW_RADIUS_MAX_M, SHADOW_RADIUS_MIN_M } from './constants';
import type { Radiometry } from './Radiometry';

/**
 * The key light and its shadow.
 *
 * One directional light carries the sun; a second, much weaker one carries the
 * moon so that a night watch still has a direction to its highlights and the
 * rigging still casts something onto the deck. The moon light does not cast
 * shadows — at 1/300 of the sun it would only buy shadow-map bandwidth.
 *
 * SHADOW FRUSTUM. The map is fitted to the SHIP, not to the camera frustum. On
 * an empty ocean the ship is the only shadow caster that matters, it never
 * leaves the origin (floating origin), and a ship-locked frustum is inherently
 * stable — a camera-fitted one swims every time the player looks around. The
 * half-extent opens up as the sun drops because a 67 m mainmast throws a very
 * long shadow at low elevations.
 *
 * TEXEL SNAPPING. The frustum centre is quantised to whole shadow texels in the
 * light's own basis before the camera is placed. Without this, sub-texel motion
 * of the centre makes every shadow edge crawl and shimmer as the ship moves,
 * which is far more noticeable than the shadow being slightly off-centre.
 */
export class SunLight {
  readonly sun = new THREE.DirectionalLight(0xffffff, 0);
  readonly moon = new THREE.DirectionalLight(0xffffff, 0);

  private xAxis = new THREE.Vector3();
  private yAxis = new THREE.Vector3();
  private zAxis = new THREE.Vector3();
  private centre = new THREE.Vector3();
  private snapped = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private altUp = new THREE.Vector3(0, 0, 1);
  private lastMapSize = 0;

  init(world: World): void {
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = SHADOW_PULLBACK_M + 260;
    // Thin standing rigging is only a few centimetres across, so a depth bias
    // large enough to kill acne on the hull would detach the shadow from every
    // line. normalBias moves the RECEIVER along its own normal instead, which
    // scales with surface curvature and leaves thin casters alone.
    sun.shadow.bias = -0.00016;
    sun.shadow.normalBias = 0.055;
    // VSM blurs the ENTIRE shadow map, twice, every frame, regardless of how
    // little of it a single ship covers: cost is blurSamples x 2 x mapSize^2.
    // At 8 taps on a 4096 map that was 268 M fetches a frame and 19 ms, the
    // largest single item in the whole budget. Six taps across a 2.2-texel
    // kernel still oversamples the penumbra — the taps land closer together
    // than one texel — so this is free visually.
    sun.shadow.blurSamples = 6;
    sun.shadow.radius = 2.2;
    sun.shadow.autoUpdate = true;
    sun.target.position.set(0, 0, 0);
    sun.matrixAutoUpdate = true;
    world.scene.add(sun, sun.target);

    const moon = this.moon;
    moon.castShadow = false;
    world.scene.add(moon, moon.target);

    this.applySettings(world);
  }

  applySettings(world: World): void {
    const size = Math.max(512, world.settings.shadowMapSize | 0);
    if (size === this.lastMapSize) return;
    this.lastMapSize = size;
    this.sun.shadow.mapSize.setScalar(size);
    // Force three to rebuild the map at the new resolution. `mapPass` — the VSM
    // blur's ping-pong target — must go with it: `WebGLShadowMap.VSMPass` only
    // rebuilds that target when it is null, so nulling `map` alone left the two
    // blur passes running at the OLD size against a new map, and every shadow in
    // the scene was wrong for the rest of the session. Latent at the default
    // tiers, because high and ultra are both 2048 and the early-out above then
    // never lets the size change; it bites the moment a player moves the quality
    // slider off 1024.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.sun.shadow.mapPass?.dispose();
    this.sun.shadow.mapPass = null;
    this.sun.shadow.needsUpdate = true;
  }

  update(world: World, radiometry: Radiometry): void {
    const env = world.env;

    this.sun.color.copy(radiometry.sunColor);
    this.sun.intensity = radiometry.sunIntensity;
    this.sun.visible = radiometry.sunIntensity > 1e-3;

    this.moon.color.copy(radiometry.moonColor);
    this.moon.intensity = radiometry.moonIntensity;
    this.moon.visible = radiometry.moonIntensity > 1e-5;

    const p = world.shipRoot.position;
    this.moon.position.set(
      p.x + env.moonDirection.x * 600,
      p.y + env.moonDirection.y * 600,
      p.z + env.moonDirection.z * 600,
    );
    this.moon.target.position.copy(p);

    if (!this.sun.visible) return;
    this.fitShadow(world, env.sunDirection);
  }

  private fitShadow(world: World, sunDir: THREE.Vector3): void {
    // Cascade count is spent on frustum TIGHTNESS rather than on split count:
    // see the note in index.ts. More cascades therefore means a smaller, denser
    // near frustum and a shorter shadow distance.
    const cascades = THREE.MathUtils.clamp(world.settings.shadowCascades, 1, 4);
    const tighten = 1 - 0.09 * (cascades - 1);
    const elevation = Math.max(0.08, sunDir.y);
    const radius =
      THREE.MathUtils.clamp(
        SHADOW_RADIUS_MIN_M / Math.pow(elevation, 0.45),
        SHADOW_RADIUS_MIN_M,
        SHADOW_RADIUS_MAX_M,
      ) * tighten;

    this.zAxis.copy(sunDir).normalize();
    // cross(up, z) degenerates with the sun at the zenith; swap the reference.
    const ref = Math.abs(this.zAxis.y) > 0.999 ? this.altUp : this.up;
    this.xAxis.crossVectors(ref, this.zAxis).normalize();
    this.yAxis.crossVectors(this.zAxis, this.xAxis).normalize();

    // Bias the centre upward: the ship's mass is at the waterline but its
    // casters run 67 m up, and centring on the rig keeps the whole mast inside.
    this.centre.copy(world.shipRoot.position);
    this.centre.y += 22;

    const texel = (2 * radius) / this.lastMapSize;
    const cx = Math.round(this.centre.dot(this.xAxis) / texel) * texel;
    const cy = Math.round(this.centre.dot(this.yAxis) / texel) * texel;
    const cz = this.centre.dot(this.zAxis);
    this.snapped.set(0, 0, 0).addScaledVector(this.xAxis, cx).addScaledVector(this.yAxis, cy).addScaledVector(this.zAxis, cz);

    this.sun.position.copy(this.snapped).addScaledVector(this.zAxis, SHADOW_PULLBACK_M);
    this.sun.target.position.copy(this.snapped);
    this.sun.target.updateMatrixWorld();

    const cam = this.sun.shadow.camera;
    if (cam.right !== radius) {
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.moon.dispose();
  }
}
