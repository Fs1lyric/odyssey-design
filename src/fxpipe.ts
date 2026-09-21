/** Odyssey Video — the preview's per-clip effect pipeline.
 *
 *  The renderer runs every clip through its own ffmpeg filter chain: the
 *  picture is fitted to the frame, each effect is applied in order to that
 *  layer, and the result is overlaid centred on the composite. Crop makes the
 *  layer smaller, rotate grows its box to hold the corners, and a later effect
 *  sees the output of an earlier one.
 *
 *  This module reproduces that chain for the monitor. Colour and pixel effects
 *  run as WebGL2 fragment shaders written against the ffmpeg filters' own
 *  formulas (eq's additive brightness, chromakey's chroma distance, vignette's
 *  cos⁴ falloff, the feathered mask's coverage); geometry runs on 2D canvases,
 *  because it changes the layer's size. Effects in neither camp are reported
 *  back by name, so the monitor can say what it is not showing and fetch an
 *  exact frame from ffmpeg while the playhead rests.
 *
 *  Every size here is in project pixels ("logical"). Surfaces are allocated at
 *  the preview resolution, `k` physical pixels per logical one, and shaders
 *  convert, so a blur radius or a crop rectangle means the same thing at any
 *  playback resolution.
 */
import type { Clip, Effect, Param, TransitionKind } from "./timeline";
import { paramAt, isAnimated } from "./timeline";

type Kind = Effect["kind"];

/** A layer in flight. `w`/`h` are logical; the canvas is `w*k` by `h*k`. */
export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** Effects that reach ffmpeg but that the preview does not reproduce, split by
 *  how much that matters. Denoisers and deinterlacers barely change a frame;
 *  the rest change it visibly, and the monitor names them. */
const SUBTLE = new Set<Kind>([
  "denoise", "deband", "deflicker", "deinterlace", "chromadenoise", "bilateral", "smartblur",
  "vaguedenoise", "gradfun", "removegrain", "owdenoise", "videolimiter", "median", "nlmeans",
  "atadenoise", "hqdn3d", "bwdeinterlace", "photosensitivity", "stabilize",
]);

/** Effects applied by the audio chain, which the picture never sees. */
const AUDIO = new Set<Kind>([
  "volume", "audiofade", "highpass", "lowpass", "loudness", "echo", "chorus", "flanger",
  "pitchshift", "noisegate", "compressor", "limiter", "stereowidth", "mono", "swapchannels",
  "trimsilence", "bass", "treble", "parametriceq", "tremolo", "vibrato", "bitcrush", "exciter",
  "subboost", "speechnorm", "audiodenoise", "allpass", "bandpass", "bandreject", "lowshelf",
  "highshelf", "crystalizer", "deesser", "dialogueenhance", "earwax", "extrastereo",
  "stereotools", "stereowiden", "supereq", "compand", "compensationdelay", "softclip", "declick",
  "dynamiceq", "pulsator",
]);

export interface BuildResult {
  layer: Surface;
  /** Visible effects the live preview left out, by display name. */
  missing: string[];
  /** Effects left out that barely change the picture. */
  subtle: number;
}

// ---------------------------------------------------------------------------
// Surfaces

/** A pool of scratch canvases, handed back all at once at the start of each
 *  frame so a steady playback allocates nothing. */
class Pool {
  private free: Surface[] = [];
  private used: Surface[] = [];

  acquire(w: number, h: number, k: number): Surface {
    const pw = Math.max(1, Math.round(w * k));
    const ph = Math.max(1, Math.round(h * k));
    let i = this.free.findIndex((s) => s.canvas.width === pw && s.canvas.height === ph);
    if (i < 0) i = this.free.length - 1;
    let s: Surface;
    if (i >= 0) {
      s = this.free.splice(i, 1)[0];
      if (s.canvas.width !== pw || s.canvas.height !== ph) {
        s.canvas.width = pw;
        s.canvas.height = ph;
      }
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = pw;
      canvas.height = ph;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      s = { canvas, ctx, w, h };
    }
    s.w = w;
    s.h = h;
    s.ctx.setTransform(k, 0, 0, k, 0, 0);
    s.ctx.globalAlpha = 1;
    s.ctx.globalCompositeOperation = "source-over";
    s.ctx.filter = "none";
    s.ctx.clearRect(0, 0, w, h);
    this.used.push(s);
    return s;
  }

  reset() {
    this.free.push(...this.used);
    this.used = [];
    // A resolution change strands canvases of the old size; keep the pool small.
    if (this.free.length > 24) this.free.length = 24;
  }
}

// ---------------------------------------------------------------------------
// Shaders

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Shared by every effect. `P` is the physical pixel centre, measured from the
 *  top-left like ffmpeg's X and Y; `L` is the same point in project pixels. */
const HEAD = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_lut;
uniform vec2 u_size;
uniform float u_k;
uniform float u_final;
out vec4 o;
vec4 at(vec2 P) { return texture(u_tex, vec2(P.x, u_size.y - P.y) / u_size); }
vec4 atz(vec2 P) {
  if (P.x < 0.0 || P.y < 0.0 || P.x > u_size.x || P.y > u_size.y) return vec4(0.0);
  return at(P);
}
// BT.601 full range, the matrix ffmpeg's RGB/YUV helpers use for keys.
vec3 yuv(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.564 + 0.5, (c.r - y) * 0.713 + 0.5);
}
vec3 rgb(vec3 v) {
  float u = v.y - 0.5, w = v.z - 0.5;
  return vec3(v.x + 1.403 * w, v.x - 0.344 * u - 0.714 * w, v.x + 1.773 * u);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 fx(vec2 P, vec2 L);
void main() {
  vec2 P = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec4 c = clamp(fx(P, P / u_k), 0.0, 1.0);
  o = u_final > 0.5 ? vec4(c.rgb * c.a, c.a) : c;
}
`;

/** One body per effect family. Each defines `fx`, returning straight alpha. */
const BODIES: Record<string, string> = {
  // eq: brightness adds to luma, contrast pivots it on mid grey, gamma bends
  // it, saturation scales chroma about neutral.
  // eq works on the stored code values, and video luma is stored in the
  // limited 16..235 range, so the arithmetic happens there.
  eq: `uniform float b, ct, s, g;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 v = yuv(p.rgb);
  float y = (16.0 + v.x * 219.0) / 255.0;
  y = clamp((y - 0.5) * ct + 0.5 + b, 0.0, 1.0);
  y = pow(y, 1.0 / max(g, 0.01));
  y = (y * 255.0 - 16.0) / 219.0;
  return vec4(rgb(vec3(y, (v.yz - 0.5) * s + 0.5)), p.a);
}`,
  // hue: rotation of the chroma vector.
  hue: `uniform float h;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 v = yuv(p.rgb); vec2 uv = v.yz - 0.5;
  float c = cos(h), s = sin(h);
  return vec4(rgb(vec3(v.x, uv.x * c - uv.y * s + 0.5, uv.x * s + uv.y * c + 0.5)), p.a);
}`,
  // colorchannelmixer, and anything else affine in R, G and B.
  // `pre` clips the mix before the offset is added, as Tint's mixer-then-LUT
  // pair does in the renderer.
  matrix: `uniform mat3 m; uniform vec3 off; uniform float pre;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 x = m * p.rgb;
  if (pre > 0.5) x = clamp(x, 0.0, 1.0);
  return vec4(x + off, p.a);
}`,
  // colorlevels with the output range left at 0..1.
  levels: `uniform vec3 lo, hi;
vec4 fx(vec2 P, vec2 L) { vec4 p = at(P); return vec4((p.rgb - lo) / max(hi - lo, vec3(1e-4)), p.a); }`,
  posterize: `uniform float n;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); float st = 256.0 / max(2.0, n);
  return vec4(floor(p.rgb * 255.0 / st) * st / 255.0, p.a);
}`,
  vibrance: `uniform float i;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 c = p.rgb;
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), sat = mx - mn;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float f = 1.0 + i * (1.0 - sign(i) * sat);
  return vec4(mix(vec3(l), c, f), p.a);
}`,
  // colorbalance: shadows, midtones and highlights weighted by lightness.
  balance: `uniform vec3 s, m, hi;
float comp(float v, float l, float sv, float mv, float hv) {
  float a = 4.0, b = 0.333, sc = 0.7;
  sv *= clamp((b - l) * a + 0.5, 0.0, 1.0) * sc;
  mv *= clamp((l - b) * a + 0.5, 0.0, 1.0) * clamp((1.0 - l - b) * a + 0.5, 0.0, 1.0) * sc;
  hv *= clamp((l + b - 1.0) * a + 0.5, 0.0, 1.0) * sc;
  return clamp(v + sv + mv + hv, 0.0, 1.0);
}
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 c = p.rgb;
  // ffmpeg's "lightness" here is max + min, not their mean.
  float l = max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b));
  return vec4(comp(c.r, l, s.r, m.r, hi.r), comp(c.g, l, s.g, m.g, hi.g), comp(c.b, l, s.b, m.b, hi.b), p.a);
}`,
  // curves: a 256-entry table per channel, built on the CPU.
  lut: `vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 i = (floor(p.rgb * 255.0 + 0.5) + 0.5) / 256.0;
  return vec4(texture(u_lut, vec2(i.r, 0.5)).r, texture(u_lut, vec2(i.g, 0.5)).g, texture(u_lut, vec2(i.b, 0.5)).b, p.a);
}`,
  swapuv: `vec4 fx(vec2 P, vec2 L) { vec4 p = at(P); vec3 v = yuv(p.rgb); return vec4(rgb(v.xzy), p.a); }`,
  // Keys. chromakey and chromahold measure distance in the chroma plane,
  // averaged over a 3x3 neighbourhood as ffmpeg does for subsampled chroma.
  chromakey: `uniform vec2 key; uniform float sim, bl, hold;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); float d = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 uv = yuv(at(P + vec2(x, y) * u_k).rgb).yz;
    d += length(uv - key) / 1.41421356;
  }
  d /= 9.0;
  float a = bl > 1e-4 ? clamp((d - sim) / bl, 0.0, 1.0) : (d > sim ? 1.0 : 0.0);
  if (hold > 0.5) { vec3 v = yuv(p.rgb); return vec4(rgb(vec3(v.x, mix(v.yz, vec2(0.5), a))), p.a); }
  return vec4(p.rgb, p.a * a);
}`,
  colorkey: `uniform vec3 key; uniform float sim, bl, hold;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 dd = p.rgb - key; float d = sqrt(dot(dd, dd) / 3.0);
  float a = bl > 1e-4 ? clamp((d - sim) / bl, 0.0, 1.0) : (d > sim ? 1.0 : 0.0);
  if (hold > 0.5) return vec4(mix(p.rgb, vec3((p.r + p.g + p.b) / 3.0), a), p.a);
  return vec4(p.rgb, p.a * a);
}`,
  lumakey: `uniform float lo, hi;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); float y = yuv(p.rgb).x;
  return vec4(p.rgb, (y >= lo && y <= hi) ? 0.0 : p.a);
}`,
  // despill, term for term: the spill map is removed from the keyed channel.
  despill: `uniform float mx, green;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 c = p.rgb; float f = 1.0 - mx;
  if (green > 0.5) { float s = max(c.g - (c.r * mx + c.b * f), 0.0); c.g = max(c.g - s, 0.0); }
  else { float s = max(c.b - (c.r * mx + c.g * f), 0.0); c.b = max(c.b - s, 0.0); }
  return vec4(c, p.a);
}`,
  // The geq mask from timeline.rs: coverage 1 inside, falling across the
  // feather outside, in the layer's own pixels.
  mask: `uniform float rect, inv; uniform vec2 ctr, half_; uniform float feather;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec2 d = L - ctr; float cov;
  if (rect > 0.5) cov = clamp(1.0 - length(max(abs(d) - half_, 0.0)) / feather, 0.0, 1.0);
  else cov = clamp(1.0 - (length(d / half_) - 1.0) * min(half_.x, half_.y) / feather, 0.0, 1.0);
  if (inv > 0.5) cov = 1.0 - cov;
  return vec4(p.rgb, p.a * cov);
}`,
  // vignette: cos(angle * r)^4, r normalised to the half-diagonal.
  vignette: `uniform float ang;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec2 hs = u_size / u_k * 0.5;
  float dn = length(L - hs) / length(hs);
  float c = cos(ang * dn); float f = dn > 1.0 ? 0.0 : c * c * c * c;
  return vec4(p.rgb * f, p.a);
}`,
  // lenscorrection: radius normalised by the half-diagonal, squared.
  lens: `uniform float k1, k2;
vec4 fx(vec2 P, vec2 L) {
  vec2 c = u_size * 0.5, d = P - c;
  float r2 = 4.0 * dot(d, d) / dot(u_size, u_size);
  vec2 s = c + d * (1.0 + k1 * r2 + k2 * r2 * r2);
  if (s.x < 0.0 || s.y < 0.0 || s.x > u_size.x || s.y > u_size.y) return vec4(0.0, 0.0, 0.0, 1.0);
  return at(s);
}`,
  pixelate: `uniform float bs;
vec4 fx(vec2 P, vec2 L) {
  float B = max(1.0, bs * u_k); vec2 o0 = floor(P / B) * B; vec4 sum = vec4(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++)
    sum += at(min(o0 + (vec2(x, y) + 0.5) * B / 4.0, u_size - 0.5));
  return sum / 16.0;
}`,
  mirror: `vec4 fx(vec2 P, vec2 L) { return at(vec2(P.x < u_size.x * 0.5 ? P.x : u_size.x - P.x, P.y)); }`,
  chromashift: `uniform float cb, cr;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); float y = yuv(p.rgb).x;
  float u = yuv(at(P - vec2(cb * u_k, 0.0)).rgb).y, v = yuv(at(P - vec2(cr * u_k, 0.0)).rgb).z;
  return vec4(rgb(vec3(y, u, v)), p.a);
}`,
  rgbashift: `uniform float sh;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P);
  return vec4(at(P - vec2(sh * u_k, 0.0)).r, p.g, at(P + vec2(sh * u_k, 0.0)).b, p.a);
}`,
  scanlines: `uniform float amt;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 v = yuv(p.rgb);
  v.x *= 1.0 - amt * mod(floor(L.y), 2.0);
  return vec4(rgb(v), p.a);
}`,
  grain: `uniform float amt, seed;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); float n = (hash(floor(L) + seed) - 0.5) * 2.0 * amt / 255.0;
  return vec4(p.rgb + n, p.a);
}`,
  // convolution runs per plane on 4:2:0 video: luma at full resolution,
  // chroma at half, each plane clipped on its own.
  conv3: `uniform mat3 kern;
vec4 fx(vec2 P, vec2 L) {
  float y0 = 0.0; vec2 c0 = vec2(0.0);
  for (int y = 0; y < 3; y++) for (int x = 0; x < 3; x++) {
    vec2 o = vec2(x - 1, y - 1) * u_k; float w = kern[x][y];
    y0 += w * yuv(at(P + o).rgb).x;
    c0 += w * (yuv(at(P + o * 2.0).rgb).yz - 0.5);
  }
  return vec4(rgb(vec3(clamp(y0, 0.0, 1.0), clamp(c0 + 0.5, 0.0, 1.0))), at(P).a);
}`,
  // Separable gaussian (gblur) and box (boxblur), one axis per pass.
  // Separable gaussian (gblur) and box (boxblur), one axis per pass. Both
  // filters take their size in each plane's own pixels, so on 4:2:0 video
  // the chroma blur spans twice the distance of the luma blur.
  gauss: `uniform vec2 dir; uniform float sigma;
vec4 fx(vec2 P, vec2 L) {
  float sc = sigma * 2.0; float r = ceil(sc * 3.0); float st = max(1.0, ceil(r / 64.0));
  float yl = 0.0, wl = 0.0; vec2 uv = vec2(0.0); float wc = 0.0, a = 0.0;
  for (float i = -r; i <= r; i += st) {
    vec4 s = at(P + dir * i); vec3 v = yuv(s.rgb);
    float w1 = exp(-0.5 * i * i / max(sigma * sigma, 1e-4));
    float w2 = exp(-0.5 * i * i / max(sc * sc, 1e-4));
    yl += v.x * w1; a += s.a * w1; wl += w1; uv += v.yz * w2; wc += w2;
  }
  return vec4(rgb(vec3(yl / wl, uv / wc)), a / wl);
}`,
  box: `uniform vec2 dir; uniform float rad;
vec4 fx(vec2 P, vec2 L) {
  float rc = rad * 2.0; float st = max(1.0, ceil(rc / 64.0));
  float yl = 0.0, nl = 0.0, a = 0.0; vec2 uv = vec2(0.0); float nc = 0.0;
  for (float i = -rc; i <= rc; i += st) {
    vec4 s = at(P + dir * i); vec3 v = yuv(s.rgb);
    if (abs(i) <= rad) { yl += v.x; a += s.a; nl += 1.0; }
    uv += v.yz; nc += 1.0;
  }
  return vec4(rgb(vec3(yl / nl, uv / nc)), a / nl);
}`,
  // unsharp 5x5 on luma only, as the renderer asks for.
  unsharp: `uniform float amt;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec3 v = yuv(p.rgb); float sum = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) sum += yuv(at(P + vec2(x, y) * u_k).rgb).x;
  v.x += amt * (v.x - sum / 25.0);
  return vec4(rgb(v), p.a);
}`,
  opacity: `uniform float a;
vec4 fx(vec2 P, vec2 L) { vec4 p = at(P); return vec4(p.rgb, p.a * a); }`,
  // fade without alpha goes through a colour: black for fades and dips to
  // black, white for dips to white.
  fadeto: `uniform float f; uniform vec3 col;
vec4 fx(vec2 P, vec2 L) { vec4 p = at(P); return vec4(mix(col, p.rgb, f), p.a); }`,
  drawbox: `uniform vec4 box; uniform vec4 col; uniform float th;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P); vec2 a = box.xy, b = box.xy + box.zw;
  bool inside = all(greaterThanEqual(L, a)) && all(lessThan(L, b));
  bool core = all(greaterThanEqual(L, a + th)) && all(lessThan(L, b - th));
  return inside && !core ? vec4(mix(p.rgb, col.rgb, col.a), p.a) : p;
}`,
  drawgrid: `uniform float sp, th; uniform vec4 col;
vec4 fx(vec2 P, vec2 L) {
  vec4 p = at(P);
  bool line = mod(L.x, sp) < th || mod(L.y, sp) < th;
  return line ? vec4(mix(p.rgb, col.rgb, col.a), p.a) : p;
}`,
  // Every transition, as the geq alpha tests in timeline.rs spell them.
  transition: `uniform float kind, pr;
vec4 fx(vec2 P, vec2 L) {
  vec2 S = u_size / u_k; float W = S.x, H = S.y, X = L.x, Y = L.y, p = pr;
  const float PI = 3.14159265;
  int k = int(kind + 0.5);
  if (k == 13) { vec4 s = at((vec2(X + W * (1.0 - p), Y)) * u_k); return X < W * p ? s : vec4(0.0); }
  if (k == 12) { vec4 s = at((vec2(X - W * (1.0 - p), Y)) * u_k); return X > W * (1.0 - p) ? s : vec4(0.0); }
  if (k == 15) { vec4 s = at((vec2(X, Y + H * (1.0 - p))) * u_k); return Y < H * p ? s : vec4(0.0); }
  if (k == 14) { vec4 s = at((vec2(X, Y - H * (1.0 - p))) * u_k); return Y > H * (1.0 - p) ? s : vec4(0.0); }
  if (k == 29) {
    float z = max(0.4, p); vec4 s = at((vec2(W, H) * 0.5 + (L - vec2(W, H) * 0.5) / z) * u_k);
    return vec4(s.rgb, s.a * p);
  }
  vec4 c = at(P); bool show = true;
  float r = length(L - vec2(W, H) * 0.5), R = length(vec2(W, H) * 0.5);
  if (k == 2) show = X < W * p;
  else if (k == 3) show = X > W * (1.0 - p);
  else if (k == 4) show = Y > H * (1.0 - p);
  else if (k == 5) show = Y < H * p;
  else if (k == 6) show = X + Y < (W + H) * p;
  else if (k == 7) show = r < p * R;
  else if (k == 8) show = r > (1.0 - p) * R;
  else if (k == 9) show = abs(X - W / 2.0) < p * W / 2.0;
  else if (k == 10) show = abs(X - W / 2.0) > (1.0 - p) * W / 2.0;
  else if (k == 11) show = mod(atan(Y - H / 2.0, X - W / 2.0) + PI, 2.0 * PI) < p * 2.0 * PI;
  else if (k == 16) show = hash(floor(L)) < p;
  else if (k == 17) show = mod(floor(X / 40.0) + floor(Y / 40.0), 2.0) * 0.5 < p;
  else if (k == 18) show = mod(Y, 40.0) / 40.0 < p;
  else if (k == 19) show = abs(Y - H / 2.0) < p * H / 2.0;
  else if (k == 20) show = abs(Y - H / 2.0) > (1.0 - p) * H / 2.0;
  else if (k == 21) show = atan(Y, X) < p * PI / 2.0;
  else if (k == 22) show = max(X / W, Y / H) < p;
  else if (k == 23) show = max((W - X) / W, Y / H) < p;
  else if (k == 24) show = mod(r, 60.0) / 60.0 < p;
  else if (k == 25) show = yuv(c.rgb).x < p;
  else if (k == 26) show = mod(X, 80.0) / 80.0 < p;
  else if (k == 27) show = mod((atan(Y - H / 2.0, X - W / 2.0) + PI) / (2.0 * PI) + r / R, 1.0) < p;
  return show ? c : vec4(0.0);
}`,
};

/** Shader index for each geq transition, matching the `kind` test above. */
const TRANSITION_CODE: Partial<Record<TransitionKind, number>> = {
  wipeleft: 2, wiperight: 3, wipeup: 4, wipedown: 5, diagonalwipe: 6, irisopen: 7, irisclose: 8,
  barndooropen: 9, barndoorclose: 10, clockwipe: 11, slideleft: 12, slideright: 13, slideup: 14,
  slidedown: 15, pixeldissolve: 16, checkerboard: 17, venetianblinds: 18, splitvertical: 19,
  splithorizontal: 20, radialwipe: 21, cornerwipetopleft: 22, cornerwipetopright: 23,
  rippledissolve: 24, lumawipe: 25, bandwipe: 26, spiral: 27, crosszoom: 29,
};

type Uniform = number | number[] | { mat3: number[] };

interface Pass {
  body: string;
  uniforms: Record<string, Uniform>;
  /** 256x1 RGBA table for the `lut` body. */
  lut?: Uint8Array;
}

interface Program {
  prog: WebGLProgram;
  loc: Map<string, WebGLUniformLocation | null>;
}

/** The GPU half: one hidden WebGL2 canvas, programs compiled on first use,
 *  and a pair of framebuffers to ping-pong between passes. */
class Gpu {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, Program | null>();
  private src: WebGLTexture;
  private lut: WebGLTexture;
  private ping: Array<{ tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }> = [];
  private vao: WebGLVertexArrayObject | null;
  /** The largest texture side the GPU accepts. */
  readonly maxSize: number;
  /** The last GL error after a run, 0 when clean. */
  error = 0;

  static create(): Gpu | null {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", {
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
        antialias: false,
        depth: false,
        stencil: false,
      });
      return gl ? new Gpu(canvas, gl) : null;
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.src = this.texture();
    this.lut = this.texture();
    this.vao = gl.createVertexArray();
    this.maxSize = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    );
    for (let i = 0; i < 2; i++) {
      const tex = this.texture();
      const fbo = gl.createFramebuffer()!;
      this.ping.push({ tex, fbo, w: 0, h: 0 });
    }
  }

  private texture(): WebGLTexture {
    const { gl } = this;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private program(body: string): Program | null {
    if (this.programs.has(body)) return this.programs.get(body)!;
    const { gl } = this;
    const compile = (type: number, text: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(`preview shader "${body}":`, gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, HEAD + BODIES[body]);
    let out: Program | null = null;
    if (vs && fs) {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) out = { prog, loc: new Map() };
      else console.error(`preview program "${body}":`, gl.getProgramInfoLog(prog));
    }
    this.programs.set(body, out);
    return out;
  }

  /** Run `passes` over `input` and draw the result into `output`, which must
   *  have the same size. Returns false if any shader failed to build. */
  run(input: Surface, passes: Pass[], output: Surface, k: number): boolean {
    const { gl } = this;
    const pw = input.canvas.width;
    const ph = input.canvas.height;
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    for (const p of passes) if (!this.program(p.body)) return false;

    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input.canvas);

    for (const f of this.ping) {
      if (f.w !== pw || f.h !== ph) {
        gl.bindTexture(gl.TEXTURE_2D, f.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pw, ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
        f.w = pw;
        f.h = ph;
      }
    }

    let read = this.src;
    passes.forEach((pass, i) => {
      const last = i === passes.length - 1;
      const target = last ? null : this.ping[i % 2];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, pw, ph);
      const prog = this.program(pass.body)!;
      gl.useProgram(prog.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, read);
      if (pass.lut) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lut);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pass.lut);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      }
      const set = (name: string, v: Uniform) => {
        if (!prog.loc.has(name)) prog.loc.set(name, gl.getUniformLocation(prog.prog, name));
        const l = prog.loc.get(name) ?? null;
        if (l === null) return;
        if (typeof v === "number") gl.uniform1f(l, v);
        else if ("mat3" in v) gl.uniformMatrix3fv(l, true, v.mat3);
        else if (v.length === 2) gl.uniform2fv(l, v);
        else if (v.length === 3) gl.uniform3fv(l, v);
        else gl.uniform4fv(l, v);
      };
      const ints = (name: string, v: number) => {
        if (!prog.loc.has(name)) prog.loc.set(name, gl.getUniformLocation(prog.prog, name));
        const l = prog.loc.get(name) ?? null;
        if (l !== null) gl.uniform1i(l, v);
      };
      ints("u_tex", 0);
      ints("u_lut", 1);
      set("u_size", [pw, ph]);
      set("u_k", k);
      set("u_final", last ? 1 : 0);
      for (const [name, v] of Object.entries(pass.uniforms)) set(name, v);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (target) read = target.tex;
    });

    const o = output.ctx;
    o.save();
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, output.canvas.width, output.canvas.height);
    o.drawImage(this.canvas, 0, 0);
    o.restore();
    this.error = gl.getError();
    return this.error === gl.NO_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Colour helpers

let probe: CanvasRenderingContext2D | null = null;

/** An ffmpeg colour as 0..1 RGBA. ffmpeg's names are the CSS/X11 set (its
 *  "green" is #008000, as CSS's is), so the browser's parser does the work;
 *  only the 0xRRGGBB spelling and the @alpha suffix need handling here. */
export function parseColour(c: string, fallback: [number, number, number] = [0, 0, 0]): [number, number, number, number] {
  let s = (c || "").trim();
  let alpha = 1;
  const at = s.indexOf("@");
  if (at > 0) {
    const a = Number(s.slice(at + 1));
    if (Number.isFinite(a)) alpha = Math.min(1, Math.max(0, a));
    s = s.slice(0, at);
  }
  if (/^0x[0-9a-f]{6}/i.test(s)) s = `#${s.slice(2, 8)}`;
  probe ??= document.createElement("canvas").getContext("2d");
  if (probe) {
    probe.fillStyle = "#010203";
    probe.fillStyle = s;
    const v = String(probe.fillStyle);
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
    if (m && !(v === "#010203" && s.toLowerCase() !== "#010203")) {
      return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, alpha];
    }
  }
  return [fallback[0] / 255, fallback[1] / 255, fallback[2] / 255, alpha];
}

/** Tint does its own arithmetic in the renderer rather than handing the
 *  colour to ffmpeg, through `parse_rgb` in timeline.rs, which knows hex and
 *  the HTML names. This is that parser, so an unknown name falls back here
 *  exactly as it does in the export. */
const HTML_COLOURS: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0],
  green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255],
  aqua: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255], silver: [192, 192, 192],
  gray: [128, 128, 128], grey: [128, 128, 128], maroon: [128, 0, 0], olive: [128, 128, 0],
  purple: [128, 0, 128], teal: [0, 128, 128], navy: [0, 0, 128], orange: [255, 165, 0],
};

function tintColour(c: string, fallback: [number, number, number]): [number, number, number] {
  const s = (c || "").trim().split("@")[0].toLowerCase();
  const named = HTML_COLOURS[s];
  const hex = /^(?:#|0x)?([0-9a-f]{6})$/.exec(s)?.[1];
  const rgb = named ?? (hex
    ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    : fallback);
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

function toUV(r: number, g: number, b: number): [number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [(b - y) * 0.564 + 0.5, (r - y) * 0.713 + 0.5];
}

/** colortemperature's kelvin-to-RGB fit, which the filter multiplies by. */
function kelvinRgb(k: number): [number, number, number] {
  const kv = k / 100;
  let r: number, g: number, b: number;
  if (kv <= 66) {
    r = 1;
    g = 0.39008157876901960784 * Math.log(kv) - 0.63184144378862745098;
  } else {
    const t = Math.max(kv - 60, 0);
    r = 1.29293618606274509804 * Math.pow(t, -0.1332047592);
    g = 1.12989086089529411765 * Math.pow(t, -0.0755148492);
  }
  if (kv >= 66) b = 1;
  else if (kv <= 19) b = 0;
  else b = 0.54320678911019607843 * Math.log(kv - 10) - 1.19625408914;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(r), c(g), c(b)];
}

/** A natural cubic spline through `pts`, sampled at 256 points, as the curves
 *  filter interpolates by default. Fewer than two points is the identity. */
function splineTable(pts: Array<[number, number]>): Float32Array {
  const out = new Float32Array(256);
  const p = [...pts].map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (p.length < 2) {
    for (let i = 0; i < 256; i++) out[i] = i / 255;
    return out;
  }
  const n = p.length;
  const h = new Array(n - 1).fill(0).map((_, i) => Math.max(1e-6, p[i + 1][0] - p[i][0]));
  // Solve for second derivatives with natural (zero) ends.
  const m = new Array(n).fill(0);
  if (n > 2) {
    const a = new Array(n).fill(0), b = new Array(n).fill(0), c = new Array(n).fill(0), d = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      a[i] = h[i - 1];
      b[i] = 2 * (h[i - 1] + h[i]);
      c[i] = h[i];
      d[i] = 6 * ((p[i + 1][1] - p[i][1]) / h[i] - (p[i][1] - p[i - 1][1]) / h[i - 1]);
    }
    for (let i = 2; i < n - 1; i++) {
      const w = a[i] / b[i - 1];
      b[i] -= w * c[i - 1];
      d[i] -= w * d[i - 1];
    }
    for (let i = n - 2; i >= 1; i--) m[i] = (d[i] - c[i] * m[i + 1]) / b[i];
  }
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let y: number;
    if (x <= p[0][0]) y = p[0][1];
    else if (x >= p[n - 1][0]) y = p[n - 1][1];
    else {
      let j = 0;
      while (j < n - 2 && x > p[j + 1][0]) j++;
      const t = x - p[j][0], hj = h[j];
      const A = (p[j + 1][1] - p[j][1]) / hj - (hj * (2 * m[j] + m[j + 1])) / 6;
      y = p[j][1] + A * t + (m[j] / 2) * t * t + ((m[j + 1] - m[j]) / (6 * hj)) * t * t * t;
    }
    out[i] = clamp01(y);
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Effect compilation

type Step =
  | { kind: "gpu"; passes: Pass[] }
  | { kind: "geo"; apply: (s: Surface) => Surface };

/** Compile one effect at clip-local time `t` into a pipeline step, or null if
 *  the preview cannot reproduce it. */
function compileEffect(e: Effect, t: number, dur: number, pool: Pool, k: number, frameW: number, frameH: number): Step | null {
  const v = (p: Param) => paramAt(p, t);
  const gpu = (body: string, uniforms: Record<string, Uniform> = {}, lut?: Uint8Array): Step =>
    ({ kind: "gpu", passes: [{ body, uniforms, lut }] });
  const matrix = (m: number[], off: [number, number, number] = [0, 0, 0], pre = 0) =>
    gpu("matrix", { m: { mat3: m }, off, pre });

  switch (e.kind) {
    case "color":
      return gpu("eq", {
        b: clamp(v(e.brightness), -1, 1), ct: clamp(v(e.contrast), -1000, 1000),
        s: clamp(v(e.saturation), 0, 3), g: clamp(v(e.gamma), 0.1, 10),
      });
    case "hue":
      return gpu("hue", { h: (v(e.degrees) * Math.PI) / 180 });
    case "blur": {
      const s = v(e.sigma) * k;
      if (s <= 0.05) return { kind: "gpu", passes: [] };
      return { kind: "gpu", passes: [
        { body: "gauss", uniforms: { dir: [1, 0], sigma: s } },
        { body: "gauss", uniforms: { dir: [0, 1], sigma: s } },
      ] };
    }
    case "boxblur": {
      const r = Math.max(0, v(e.radius)) * k;
      if (r < 0.5) return { kind: "gpu", passes: [] };
      return { kind: "gpu", passes: [
        { body: "box", uniforms: { dir: [1, 0], rad: Math.round(r) } },
        { body: "box", uniforms: { dir: [0, 1], rad: Math.round(r) } },
      ] };
    }
    case "sharpen":
      return gpu("unsharp", { amt: v(e.amount) });
    case "crisp":
      return gpu("conv3", { kern: { mat3: [0, -1, 0, -1, 5, -1, 0, -1, 0] } });
    case "emboss":
      return gpu("conv3", { kern: { mat3: [-2, -1, 0, -1, 1, 1, 0, 1, 2] } });
    case "opacity":
      return gpu("opacity", { a: clamp01(v(e.level)) });
    case "fade": {
      let f = 1;
      if (e.in_secs > 0 && t < e.in_secs) f *= clamp01(t / e.in_secs);
      if (e.out_secs > 0 && t > dur - e.out_secs) f *= clamp01((dur - t) / e.out_secs);
      return gpu("fadeto", { f, col: [0, 0, 0] });
    }
    case "vignette": {
      // An unanimated angle of zero means the filter's own default.
      const a = isAnimated(e.angle) ? v(e.angle) : (v(e.angle) === 0 ? 0.6 : v(e.angle));
      return gpu("vignette", { ang: clamp(a, 0, Math.PI / 2) });
    }
    case "chromakey":
    case "chromahold": {
      const [r, g, b] = parseColour(e.color, [0, 128, 0]);
      return gpu("chromakey", {
        key: toUV(r, g, b), sim: clamp(v(e.similarity), 0.00001, 1), bl: clamp01(v(e.blend)),
        hold: e.kind === "chromahold" ? 1 : 0,
      });
    }
    case "colorkey":
    case "colorhold": {
      const [r, g, b] = parseColour(e.color, [0, 128, 0]);
      return gpu("colorkey", {
        key: [r, g, b], sim: clamp(v(e.similarity), 0.00001, 1), bl: clamp01(v(e.blend)),
        hold: e.kind === "colorhold" ? 1 : 0,
      });
    }
    case "lumakey": {
      const th = v(e.threshold), tol = v(e.tolerance);
      return gpu("lumakey", { lo: th - tol, hi: th + tol });
    }
    case "despill":
      return gpu("despill", { mx: clamp01(v(e.amount)), green: e.colour.toLowerCase() === "blue" ? 0 : 1 });
    case "mask":
      // Percentages of the layer as it is when the mask runs, which only the
      // pipeline knows; `build` resolves them into pixels.
      return gpu("mask", {
        rect: e.shape === "rectangle" ? 1 : 0, inv: e.invert ? 1 : 0,
        feather: Math.max(0.5, v(e.feather)),
        pct: [v(e.x), v(e.y), v(e.width), v(e.height)],
      });
    case "tint": {
      const a = clamp01(e.amount);
      const [br, bg, bb] = tintColour(e.black, [0, 0, 0]);
      const [wr, wg, wb] = tintColour(e.white, [255, 255, 255]);
      const luma = [0.299, 0.587, 0.114];
      const lo = [br, bg, bb], hi = [wr, wg, wb];
      const m: number[] = [];
      for (let ch = 0; ch < 3; ch++) {
        for (let src = 0; src < 3; src++) {
          m.push(clamp((ch === src ? 1 - a : 0) + a * (hi[ch] - lo[ch]) * luma[src], -2, 2));
        }
      }
      return matrix(m, [a * lo[0], a * lo[1], a * lo[2]], 1);
    }
    case "exposure": {
      const s = Math.pow(2, v(e.stops));
      return matrix([s, 0, 0, 0, s, 0, 0, 0, s]);
    }
    case "invert":
      return matrix([-1, 0, 0, 0, -1, 0, 0, 0, -1], [1, 1, 1]);
    case "monochrome":
      return matrix([0.3, 0.4, 0.3, 0.3, 0.4, 0.3, 0.3, 0.4, 0.3]);
    case "sepia":
      return matrix([0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131]);
    case "channelmixer":
      return matrix([clamp(v(e.rr), -2, 2), 0, 0, 0, clamp(v(e.gg), -2, 2), 0, 0, 0, clamp(v(e.bb), -2, 2)]);
    case "temperature": {
      const [r, g, b] = kelvinRgb(v(e.kelvin));
      return matrix([r, 0, 0, 0, g, 0, 0, 0, b]);
    }
    case "levels": {
      const b = v(e.black), w = v(e.white);
      return gpu("levels", { lo: [b, b, b], hi: [w, w, w] });
    }
    case "colorlevels": {
      const b = clamp(v(e.black), -1, 1), w = clamp(v(e.white), -1, 1);
      return gpu("levels", { lo: [b, b, b], hi: [w, w, w] });
    }
    case "posterize":
      return gpu("posterize", { n: v(e.levels) });
    case "vibrance":
      return gpu("vibrance", { i: clamp(v(e.intensity), -2, 2) });
    case "colorbalance":
      return gpu("balance", {
        s: [0, 0, 0], hi: [0, 0, 0],
        m: [clamp(v(e.r), -1, 1), clamp(v(e.g), -1, 1), clamp(v(e.b), -1, 1)],
      });
    case "colorwheels":
      return gpu("balance", {
        s: [v(e.lift_r), v(e.lift_g), v(e.lift_b)],
        m: [v(e.gamma_r), v(e.gamma_g), v(e.gamma_b)],
        hi: [v(e.gain_r), v(e.gain_g), v(e.gain_b)],
      });
    case "curves": {
      const master = splineTable(e.master.length > 1 ? e.master : []);
      const chans = [e.red, e.green, e.blue].map((pts) => splineTable(pts.length > 1 ? pts : []));
      const table = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        // The master curve is a second pass over each channel's own curve.
        for (let c = 0; c < 3; c++) {
          const first = chans[c][i];
          table[i * 4 + c] = Math.round(master[Math.round(first * 255)] * 255);
        }
        table[i * 4 + 3] = 255;
      }
      return gpu("lut", {}, table);
    }
    case "swapuv":
      return gpu("swapuv");
    case "lenscorrect":
      return gpu("lens", { k1: v(e.k1), k2: v(e.k2) });
    case "pixelate":
      return gpu("pixelate", { bs: Math.max(1, v(e.size)) });
    case "mirror":
      return gpu("mirror");
    case "chromashift":
      return gpu("chromashift", { cb: v(e.x), cr: v(e.y) });
    case "chromaticaberration":
      return gpu("rgbashift", { sh: Math.round(clamp(v(e.amount), -255, 255)) });
    case "scanlines":
      return gpu("scanlines", { amt: clamp01(v(e.amount)) });
    case "grain":
      return gpu("grain", { amt: clamp(e.strength, 0, 100), seed: Math.floor(t * 30) % 997 });
    case "drawbox": {
      const col = parseColour(e.color, [255, 0, 0]);
      return gpu("drawbox", {
        box: [Math.round(v(e.x)), Math.round(v(e.y)), Math.max(1, Math.round(v(e.w))), Math.max(1, Math.round(v(e.h)))],
        col, th: clamp(Math.round(v(e.thickness)), 1, 64),
      });
    }
    case "drawgrid": {
      const col = parseColour(e.color, [255, 255, 255]);
      return gpu("drawgrid", { sp: clamp(Math.round(v(e.spacing)), 2, 4096), th: clamp(Math.round(v(e.thickness)), 1, 32), col });
    }

    // ---- geometry: these change the layer's size, so they run in 2D ----
    case "crop":
      return {
        kind: "geo", apply: (s) => {
          // crop clamps its size to the input and its origin into range.
          const cw = clamp(Math.round(e.width), 1, s.w);
          const ch = clamp(Math.round(e.height), 1, s.h);
          const x = clamp(v(e.x), 0, s.w - cw);
          const y = clamp(v(e.y), 0, s.h - ch);
          const o = pool.acquire(cw, ch, k);
          o.ctx.drawImage(s.canvas, x * k, y * k, cw * k, ch * k, 0, 0, cw, ch);
          return o;
        },
      };
    case "rotate":
      return {
        kind: "geo", apply: (s) => {
          const a = (v(e.degrees) * Math.PI) / 180;
          // The output box is sized once, from the angle at the start.
          const a0 = (paramAt(e.degrees, 0) * Math.PI) / 180;
          const ow = Math.max(1, Math.round(Math.abs(s.w * Math.cos(a0)) + Math.abs(s.h * Math.sin(a0))));
          const oh = Math.max(1, Math.round(Math.abs(s.w * Math.sin(a0)) + Math.abs(s.h * Math.cos(a0))));
          const o = pool.acquire(ow, oh, k);
          o.ctx.translate(ow / 2, oh / 2);
          o.ctx.rotate(a);
          o.ctx.drawImage(s.canvas, -s.w / 2, -s.h / 2, s.w, s.h);
          return o;
        },
      };
    case "flip":
      if (!e.horizontal && !e.vertical) return { kind: "gpu", passes: [] };
      return {
        kind: "geo", apply: (s) => {
          const o = pool.acquire(s.w, s.h, k);
          o.ctx.translate(e.horizontal ? s.w : 0, e.vertical ? s.h : 0);
          o.ctx.scale(e.horizontal ? -1 : 1, e.vertical ? -1 : 1);
          o.ctx.drawImage(s.canvas, 0, 0, s.w, s.h);
          return o;
        },
      };
    case "transpose":
      return {
        kind: "geo", apply: (s) => {
          const dir = clamp(Math.round(v(e.dir)), 0, 3);
          const o = pool.acquire(s.h, s.w, k);
          const c = o.ctx;
          // 0: counter-clockwise and flipped, 1: clockwise, 2: counter-
          // clockwise, 3: clockwise and flipped. The flipped pair is a
          // transpose about a diagonal.
          if (dir === 1) { c.translate(s.h, 0); c.rotate(Math.PI / 2); }
          else if (dir === 2) { c.translate(0, s.w); c.rotate(-Math.PI / 2); }
          else if (dir === 0) { c.transform(0, 1, 1, 0, 0, 0); }
          else { c.translate(s.h, s.w); c.transform(0, -1, -1, 0, 0, 0); }
          c.drawImage(s.canvas, 0, 0, s.w, s.h);
          return o;
        },
      };
    case "reframe":
      return {
        kind: "geo", apply: (s) => {
          const a = clamp(e.aspect, 0.2, 5);
          const ow = Math.round(Math.max(s.w, s.h * a));
          const oh = Math.round(Math.max(s.h, s.w / a));
          const o = pool.acquire(ow, oh, k);
          o.ctx.drawImage(s.canvas, (ow - s.w) / 2, (oh - s.h) / 2, s.w, s.h);
          return o;
        },
      };
    case "transform":
      return {
        kind: "geo", apply: (s) => {
          // scale to the project size times the factor, then pad back to the
          // project size. The pad offset is fixed from the starting scale.
          const sc = Math.max(0.01, v(e.scale));
          const s0 = Math.max(0.01, paramAt(e.scale, 0));
          const nw = Math.max(2, Math.round(frameW * sc));
          const nh = Math.max(2, Math.round(frameH * sc));
          const o = pool.acquire(frameW, frameH, k);
          const ox = (frameW - frameW * s0) / 2 + v(e.x);
          const oy = (frameH - frameH * s0) / 2 + v(e.y);
          o.ctx.drawImage(s.canvas, ox, oy, nw, nh);
          return o;
        },
      };
    case "text":
      return {
        kind: "geo", apply: (s) => {
          const c = s.ctx;
          c.save();
          c.fillStyle = cssOf(e.color);
          c.globalAlpha = parseColour(e.color)[3];
          c.font = `${e.size}px "Adwaita Sans", system-ui, sans-serif`;
          c.textAlign = "left";
          c.textBaseline = "top";
          c.fillText(e.content, v(e.x), v(e.y));
          c.restore();
          return s;
        },
      };
    default:
      return null;
  }
}

function cssOf(c: string): string {
  const [r, g, b] = parseColour(c);
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** The transition at the head of a clip, as the renderer's chain applies it:
 *  after the effects, before the motion. */
function transitionStep(clip: Clip, t: number): Step | null {
  const tr = clip.transition_in;
  if (!tr) return null;
  const d = Math.max(0.02, tr.duration);
  const p = clamp01(t / d);
  if (p >= 1) return null;
  if (tr.kind === "dissolve") return { kind: "gpu", passes: [{ body: "opacity", uniforms: { a: p } }] };
  if (tr.kind === "diptoblack") return { kind: "gpu", passes: [{ body: "fadeto", uniforms: { f: p, col: [0, 0, 0] } }] };
  if (tr.kind === "diptowhite") return { kind: "gpu", passes: [{ body: "fadeto", uniforms: { f: p, col: [1, 1, 1] } }] };
  const code = TRANSITION_CODE[tr.kind];
  if (code === undefined) return null;
  return { kind: "gpu", passes: [{ body: "transition", uniforms: { kind: code, pr: p } }] };
}

/** Human names for the effects the monitor reports as missing. */
function effectName(e: Effect): string {
  if (e.kind === "frei0r") return `frei0r ${e.name}`;
  if (e.kind === "lut3d") return "LUT";
  return e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
}

// ---------------------------------------------------------------------------
// The pipeline

export class FxPipeline {
  private pool = new Pool();
  private gpu: Gpu | null | undefined;
  /** GPU passes that failed and were skipped, since construction. */
  failures = 0;

  /** The GPU's largest texture side, or 0 without a GPU path. */
  get maxTexture(): number {
    return this.accelerated ? this.gpu!.maxSize : 0;
  }

  /** True when the GPU path is available. Without it the preview still runs
   *  geometry and reports every colour effect as missing. */
  get accelerated(): boolean {
    this.gpu ??= Gpu.create();
    return this.gpu !== null;
  }

  /** Call once per composited frame, before building any layer. */
  beginFrame() {
    this.pool.reset();
  }

  /** A blank logical-size surface, for sources and adjustment snapshots. */
  surface(w: number, h: number, k: number): Surface {
    return this.pool.acquire(w, h, k);
  }

  /** Run a clip's effects over `layer` in order, then its head transition.
   *  `bypass` skips the effects, for the split compare. */
  build(
    clip: Clip,
    layer: Surface,
    t: number,
    dur: number,
    k: number,
    frameW: number,
    frameH: number,
    bypass = false,
  ): BuildResult {
    const missing: string[] = [];
    let subtle = 0;
    let s = layer;
    let queue: Pass[] = [];

    const flush = () => {
      if (!queue.length) return;
      const gpu = this.gpu;
      if (gpu) {
        // An 8K layer rotated grows past the largest texture many GPUs take
        // (8485 px at 45 degrees against a common 8192). Such a pass runs at
        // the largest size the GPU accepts; the layer keeps its logical size,
        // so only its sharpness drops, and only for that layer.
        let src = s;
        let kk = k;
        const side = Math.max(s.canvas.width, s.canvas.height);
        if (side > gpu.maxSize) {
          kk = k * ((gpu.maxSize - 1) / side);
          src = this.pool.acquire(s.w, s.h, kk);
          src.ctx.drawImage(s.canvas, 0, 0, s.w, s.h);
        }
        const out = this.pool.acquire(s.w, s.h, kk);
        if (gpu.run(src, queue, out, kk)) s = out;
        else this.failures++;
      }
      queue = [];
    };

    const steps: Array<{ step: Step; e?: Effect }> = [];
    if (!bypass) {
      for (const e of clip.effects) {
        if (e.enabled === false || AUDIO.has(e.kind)) continue;
        const step = compileEffect(e, t, dur, this.pool, k, frameW, frameH);
        if (!step || (step.kind === "gpu" && step.passes.length > 0 && !this.accelerated)) {
          if (SUBTLE.has(e.kind)) subtle++;
          else missing.push(effectName(e));
          continue;
        }
        steps.push({ step, e });
      }
    }
    const tr = transitionStep(clip, t);
    if (tr && (tr.kind !== "gpu" || this.accelerated)) steps.push({ step: tr });

    for (const { step } of steps) {
      if (step.kind === "gpu") {
        for (const pass of step.passes) {
          if (pass.body === "mask") pass.uniforms = maskUniforms(pass.uniforms, s);
          queue.push(pass);
        }
      } else {
        flush();
        s = step.apply(s);
      }
    }
    flush();
    return { layer: s, missing, subtle };
  }
}

/** Resolve a mask's percentages against the layer it is applied to. */
function maskUniforms(u: Record<string, Uniform>, s: Surface): Record<string, Uniform> {
  const { pct, ...rest } = u;
  const [x, y, w, h] = Array.isArray(pct) ? pct : [50, 50, 50, 50];
  return {
    ...rest,
    ctr: [(s.w * x) / 100, (s.h * y) / 100],
    half_: [Math.max(1, (s.w * w) / 200), Math.max(1, (s.h * h) / 200)],
  };
}
