// Minimal stub: textures.ts only uses these THREE symbols.
export const RGBAFormat = 1023;
export const UnsignedByteType = 1009;
export const SRGBColorSpace = 'srgb';
export const NoColorSpace = '';
export const RepeatWrapping = 1000;
export const LinearFilter = 1006;
export const LinearMipmapLinearFilter = 1008;
export class DataTexture {
  constructor(data, w, h) { this.image = { data, width: w, height: h }; this.data = data; }
  dispose() {}
}
