import * as THREE from 'three';
import { DEG } from '../util/math';

/**
 * World -> equatorial rotation for the star field.
 *
 * The star shader works in the standard equatorial Cartesian frame
 * (x toward RA 0h on the equator, y toward RA 6h, z toward the north celestial
 * pole) because that is the frame the Milky Way's galactic pole constants are
 * written in. Everything here exists to get a world-space view direction into
 * that frame, which is what makes the sky rotate about Polaris at the right
 * angle for `env.latitude` and drift 3m56s per day against the sun.
 *
 * Two rotations, composed:
 *
 *   M1  world -> hour-angle frame. Rows are the world-space directions of the
 *       local meridian point on the celestial equator, west, and the pole.
 *       Depends only on latitude.
 *
 *   R   hour-angle -> equatorial. A rotation by the local sidereal time, with
 *       the handedness flip between hour angle (increases westward) and right
 *       ascension (increases eastward). R is an involution, so it is its own
 *       inverse.
 *
 * The local sidereal time is not tracked separately: it is recovered from the
 * sun's own position, LST = HA_sun + RA_sun. That guarantees the star field can
 * never drift out of step with the sun the weather director publishes, however
 * the player scrubs or pins the clock.
 */
export class Sidereal {
  /** World -> equatorial. Feed this to the star shader. */
  readonly matrix = new THREE.Matrix3();
  /** North celestial pole, world space. The moon's north is aligned to it. */
  readonly pole = new THREE.Vector3(0, 1, 0);
  /** Local sidereal time, radians. */
  lst = 0;

  private mx = new THREE.Vector3();
  private my = new THREE.Vector3();
  private mz = new THREE.Vector3();
  private sunHourFrame = new THREE.Vector3();
  private lastLat = NaN;

  update(latitudeDeg: number, dayOfYear: number, sunDirection: THREE.Vector3): void {
    if (latitudeDeg !== this.lastLat) {
      this.lastLat = latitudeDeg;
      const lat = latitudeDeg * DEG;
      const sl = Math.sin(lat);
      const cl = Math.cos(lat);
      // Bearings are meteorological: north is world -Z, east is world +X.
      this.mx.set(0, cl, sl); // meridian point on the celestial equator
      this.my.set(-1, 0, 0); // west
      this.mz.set(0, sl, -cl); // north celestial pole
      this.pole.copy(this.mz);
    }

    const h = this.sunHourFrame.set(
      sunDirection.dot(this.mx),
      sunDirection.dot(this.my),
      sunDirection.dot(this.mz),
    );
    const hourAngleSun = Math.atan2(h.y, h.x);
    this.lst = hourAngleSun + solarRightAscension(dayOfYear);

    const c = Math.cos(this.lst);
    const s = Math.sin(this.lst);
    // matrix = R * M1, written out so no temporaries are allocated.
    const e = this.matrix.elements;
    // three's Matrix3 is column-major: e[col*3 + row].
    e[0] = c * this.mx.x + s * this.my.x;
    e[3] = c * this.mx.y + s * this.my.y;
    e[6] = c * this.mx.z + s * this.my.z;
    e[1] = s * this.mx.x - c * this.my.x;
    e[4] = s * this.mx.y - c * this.my.y;
    e[7] = s * this.mx.z - c * this.my.z;
    e[2] = this.mz.x;
    e[5] = this.mz.y;
    e[8] = this.mz.z;
  }
}

/** Days from J2000.0 to 2024-01-01 00:00 UT — the same epoch env/Celestial uses. */
const EPOCH_OFFSET_DAYS = 8765.5;

/**
 * Right ascension of the sun, radians. Low-precision Almanac series, identical
 * to the one in env/Celestial so the two never disagree about where the sun is.
 */
function solarRightAscension(dayOfYear: number): number {
  const n = EPOCH_OFFSET_DAYS + dayOfYear;
  const meanLon = 280.46 + 0.9856474 * n;
  const meanAnom = (357.528 + 0.9856003 * n) * DEG;
  const lon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG;
  const obliquity = (23.439 - 4e-7 * n) * DEG;
  return Math.atan2(Math.cos(obliquity) * Math.sin(lon), Math.cos(lon));
}
