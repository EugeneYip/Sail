import { GLSL } from '../../util/glsl';

/**
 * Scene -> working buffer. Applies exposure and nothing else.
 *
 * Exposure has to land *before* anti-aliasing, not in the composite. Every
 * later pass that reasons about "how bright is bright" — the TAA neighbourhood
 * clamp, the Karis bloom weight, FXAA's luma threshold — works in the
 * reversible `tmap` compression, and that compression only behaves if 1.0 means
 * roughly display white. Pre-exposure scene radiance spans six orders of
 * magnitude between night and noon, so applying exposure last would silently
 * change the strength of the temporal clamp with the time of day.
 *
 * It is also the one place a NaN or an Inf from another subsystem can be caught
 * before it poisons the bloom pyramid and the TAA history, where a single bad
 * texel spreads over the whole frame and never leaves.
 */
export const PREPARE_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
uniform sampler2D tScene;
// 1x1 adaptation state written by exposure/adapt. Sampled rather than passed as
// a uniform so that no stage of the frame ever reads a target back to the CPU.
uniform sampler2D tExposure;
uniform float uClampMax;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c = mix(c, vec3(0.0), vec3(notEqual(c, c)));            // NaN
  c = min(max(c, vec3(0.0)), vec3(65000.0));              // Inf
  c *= texture2D(tExposure, vec2(0.5)).g;
  // Firefly clamp, in exposed units: +6 stops over white still blooms hard but
  // cannot survive a neighbourhood variance test on its own.
  gl_FragColor = vec4(min(c, vec3(uClampMax)), 1.0);
}
`;

/**
 * Scene depth attachment -> a standalone R32F texture.
 *
 * This exists for a correctness reason, not a convenience one. The scene's
 * `DepthTexture` is an *attachment* of the scene framebuffer, so any material
 * that samples it while the scene is being rendered forms a framebuffer
 * feedback loop: the driver rejects the draw outright
 * (`glDrawElementsInstanced: Feedback loop formed between Framebuffer and
 * active Texture`) and the object silently disappears. Soft particles, screen
 * space refraction and contact fades all want exactly that texture. Copying it
 * out once per frame gives them a sampler that is never attached to anything,
 * with last frame's contents — which is what a screen-space effect wants and
 * what `PostExt.depthTexture` has always claimed to be.
 *
 * R32F, not R16F: non-linear depth spends almost all of its range next to 1.0
 * and half floats have 11 bits of mantissa there.
 */
export const DEPTH_COPY_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tDepth, vUv).r, 0.0, 0.0, 1.0); }
`;

/** Straight copy. Used for the TAA history seed and for debug taps. */
export const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0); }
`;
