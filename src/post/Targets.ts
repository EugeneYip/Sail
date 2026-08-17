import * as THREE from 'three';

export type TargetKind = 'rgba16f' | 'rg16f' | 'r16f' | 'rgba32f' | 'rgba8' | 'rg8' | 'r8';

interface Spec {
  format: THREE.PixelFormat;
  type: THREE.TextureDataType;
  bytes: number;
}

const SPECS: Record<TargetKind, Spec> = {
  rgba16f: { format: THREE.RGBAFormat, type: THREE.HalfFloatType, bytes: 8 },
  rg16f: { format: THREE.RGFormat, type: THREE.HalfFloatType, bytes: 4 },
  r16f: { format: THREE.RedFormat, type: THREE.HalfFloatType, bytes: 2 },
  rgba32f: { format: THREE.RGBAFormat, type: THREE.FloatType, bytes: 16 },
  rgba8: { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, bytes: 4 },
  rg8: { format: THREE.RGFormat, type: THREE.UnsignedByteType, bytes: 2 },
  r8: { format: THREE.RedFormat, type: THREE.UnsignedByteType, bytes: 1 },
};

interface Entry {
  rt: THREE.WebGLRenderTarget;
  kind: TargetKind;
  depth: boolean;
}

/**
 * Keyed render-target pool. Everything in the post stack asks for targets by a
 * stable name, so two stages that are never live at the same time can share one
 * allocation just by using the same key (see `Pipeline` for the sharing map).
 * Also the single place that knows our VRAM footprint.
 */
export class Targets {
  private map = new Map<string, Entry>();

  get(
    key: string,
    width: number,
    height: number,
    kind: TargetKind = 'rgba16f',
    opts: { depth?: boolean; nearest?: boolean; wrapClamp?: boolean } = {},
  ): THREE.WebGLRenderTarget {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const existing = this.map.get(key);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(`post: target "${key}" reused with kind ${kind} but was ${existing.kind}`);
      }
      if (existing.rt.width !== w || existing.rt.height !== h) existing.rt.setSize(w, h);
      return existing.rt;
    }

    const spec = SPECS[kind];
    const filter = opts.nearest ? THREE.NearestFilter : THREE.LinearFilter;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      format: spec.format,
      type: spec.type,
      colorSpace: THREE.NoColorSpace,
      minFilter: filter,
      magFilter: filter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: !!opts.depth,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0,
    });
    rt.texture.name = `post/${key}`;
    if (opts.depth) {
      // 32-bit float depth: we unproject it for velocity and DoF, and 24-bit
      // integer depth at a 60 km far plane loses far too much precision.
      const dt = new THREE.DepthTexture(w, h, THREE.FloatType);
      dt.format = THREE.DepthFormat;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      dt.name = `post/${key}.depth`;
      rt.depthTexture = dt;
    }
    this.map.set(key, { rt, kind, depth: !!opts.depth });
    return rt;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Drop one target (used when a quality change makes a stage redundant). */
  release(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    e.rt.depthTexture?.dispose();
    e.rt.dispose();
    this.map.delete(key);
  }

  /** Total allocated bytes, for the perf HUD and the VRAM report. */
  bytes(): number {
    let total = 0;
    for (const e of this.map.values()) {
      const px = e.rt.width * e.rt.height;
      total += px * SPECS[e.kind].bytes;
      if (e.depth) total += px * 4;
    }
    return total;
  }

  breakdown(): { key: string; w: number; h: number; kind: string; mb: number }[] {
    const out: { key: string; w: number; h: number; kind: string; mb: number }[] = [];
    for (const [key, e] of this.map) {
      const px = e.rt.width * e.rt.height;
      const bytes = px * SPECS[e.kind].bytes + (e.depth ? px * 4 : 0);
      out.push({ key, w: e.rt.width, h: e.rt.height, kind: e.kind, mb: bytes / 1048576 });
    }
    return out.sort((a, b) => b.mb - a.mb);
  }

  dispose(): void {
    for (const e of this.map.values()) {
      e.rt.depthTexture?.dispose();
      e.rt.dispose();
    }
    this.map.clear();
  }
}
