/** Odyssey Video — a live EBU R128 / ITU-R BS.1770-4 loudness meter.
 *
 *  Taps the preview's master bus. The signal is K-weighted (a high shelf
 *  modelling the head, then a high-pass), squared and summed per channel into
 *  100 ms blocks. From those blocks:
 *
 *    momentary   the last 400 ms (4 blocks)
 *    short-term  the last 3 s (30 blocks)
 *    integrated  every 400 ms window since reset, overlapping by 75%, gated
 *                absolutely at -70 LUFS and then relatively at 10 LU below
 *                the mean of what survived the first gate
 *
 *  This meters what the monitor plays. The monitor does not run the audio
 *  effects ffmpeg does, so for delivery the export is measured with ffmpeg's
 *  own ebur128 (`measure_loudness`); the live meter is for mixing by ear.
 */

const BLOCK = 0.1;
const ABS_GATE = -70;

/** BS.1770's two K-weighting stages as biquad coefficients at `fs`: a high
 *  shelf (+4 dB about 1.7 kHz) and the RLB high-pass (about 38 Hz).
 *  Web Audio's own BiquadFilterNode cannot stand in: its shelf has a fixed
 *  slope and its high-pass Q is in decibels. Nor can the audio cookbook's
 *  shelf with these parameters, which reads 0.26 LU low on the standard's
 *  reference tone. */
export function kWeighting(fs: number): Array<{ b: number[]; a: number[] }> {
  // libebur128's bilinear design, which reproduces the standard's 48 kHz
  // coefficient table exactly and extends it to other rates.
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773;
  K = Math.tan((Math.PI * f1) / fs);
  a0 = 1 + K / Q1 + K * K;
  const highpass = { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0] };
  return [shelf, highpass];
}

/** Mean square to loudness, BS.1770's -0.691 offset included. */
export function lufs(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity;
}

/** Gated integrated loudness over 400 ms window energies (BS.1770-4 §5). */
export function integrate(windows: number[]): number {
  const loud = windows.filter((w) => lufs(w) > ABS_GATE);
  if (!loud.length) return -Infinity;
  const relative = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const kept = loud.filter((w) => lufs(w) > relative);
  if (!kept.length) return -Infinity;
  return lufs(kept.reduce((a, b) => a + b, 0) / kept.length);
}

export interface LoudnessReading {
  momentary: number;
  shortTerm: number;
  integrated: number;
  /** Highest sample since reset, dBFS. Sample peak, not true peak. */
  peak: number;
}

export class LoudnessMeter {
  private blocks: number[] = [];
  private windows: number[] = [];
  private peakLin = 0;
  private acc = 0;
  private accN = 0;
  private blockLen: number;
  private nodes: AudioNode[] = [];
  /** Blocks are only counted while this is on, so pauses do not dilute the
   *  integrated figure (the absolute gate would drop the silence anyway). */
  active = false;

  constructor(ctx: AudioContext, input: AudioNode) {
    this.blockLen = Math.round(ctx.sampleRate * BLOCK);
    const [s1, s2] = kWeighting(ctx.sampleRate);
    const shelf = ctx.createIIRFilter(s1.b, s1.a);
    const hp = ctx.createIIRFilter(s2.b, s2.a);
    // ScriptProcessor is deprecated but, unlike an AudioWorklet, works
    // outside a secure context, which a desktop webview is not always.
    const proc = ctx.createScriptProcessor(2048, 2, 1);
    proc.onaudioprocess = (ev) => this.take(ev.inputBuffer);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    input.connect(shelf);
    shelf.connect(hp);
    hp.connect(proc);
    // A processor only runs while connected to the destination; the zero
    // gain keeps it inaudible.
    proc.connect(sink);
    sink.connect(ctx.destination);
    // The raw bus feeds the peak reading, which is not K-weighted.
    const raw = ctx.createScriptProcessor(2048, 2, 1);
    raw.onaudioprocess = (ev) => {
      if (!this.active) return;
      for (let c = 0; c < ev.inputBuffer.numberOfChannels; c++) {
        const d = ev.inputBuffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const v = Math.abs(d[i]);
          if (v > this.peakLin) this.peakLin = v;
        }
      }
    };
    input.connect(raw);
    raw.connect(sink);
    this.nodes = [shelf, hp, proc, raw, sink];
  }

  private take(buf: AudioBuffer) {
    if (!this.active) return;
    const chans = Math.min(2, buf.numberOfChannels);
    const data = Array.from({ length: chans }, (_, c) => buf.getChannelData(c));
    for (let i = 0; i < buf.length; i++) {
      // Left and right both weigh 1.0 in BS.1770.
      let e = 0;
      for (let c = 0; c < chans; c++) e += data[c][i] * data[c][i];
      this.acc += e;
      if (++this.accN === this.blockLen) {
        this.blocks.push(this.acc / this.blockLen);
        this.acc = 0;
        this.accN = 0;
        if (this.blocks.length > 30) this.blocks.shift();
        // Each new block completes a 400 ms window overlapping the last by
        // three blocks, which is the 75% overlap the gating is defined on.
        if (this.blocks.length >= 4) this.windows.push(mean(this.blocks.slice(-4)));
      }
    }
  }

  reading(): LoudnessReading {
    return {
      momentary: this.blocks.length >= 4 ? lufs(mean(this.blocks.slice(-4))) : -Infinity,
      shortTerm: this.blocks.length >= 30 ? lufs(mean(this.blocks)) : -Infinity,
      integrated: integrate(this.windows),
      peak: this.peakLin > 0 ? 20 * Math.log10(this.peakLin) : -Infinity,
    };
  }

  reset() {
    this.blocks = [];
    this.windows = [];
    this.peakLin = 0;
    this.acc = 0;
    this.accN = 0;
  }

  destroy() {
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
    this.nodes = [];
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
