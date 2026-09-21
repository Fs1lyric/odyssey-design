/** Calibration of the live R128 meter against BS.1770-4's reference points.
 *  Runs the meter's K-weighting coefficients as difference equations and
 *  applies its block, window and gating maths. */
import { integrate, kWeighting, lufs } from "../../src/loudness";

const RATE = 48000;

function kWeighted(freq: number, dbfs: number, seconds: number, channels = 2): Float32Array[] {
  const n = RATE * seconds;
  const amp = Math.pow(10, dbfs / 20);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  let y = x;
  for (const { b, a } of kWeighting(RATE)) {
    const out = new Float32Array(n);
    const [b0, b1, b2] = b.map((v) => v / a[0]);
    const [, a1, a2] = a.map((v) => v / a[0]);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v;
      out[i] = v;
    }
    y = out;
  }
  return Array.from({ length: channels }, () => y);
}

function windows(data: Float32Array[], skip = 4800): number[] {
  const block = 4800;
  const blocks: number[] = [];
  for (let s = skip; s + block <= data[0].length; s += block) {
    let e = 0;
    for (const ch of data) for (let i = s; i < s + block; i++) e += ch[i] * ch[i];
    blocks.push(e / block);
  }
  const out: number[] = [];
  for (let i = 3; i < blocks.length; i++) out.push((blocks[i] + blocks[i - 1] + blocks[i - 2] + blocks[i - 3]) / 4);
  return out;
}

const lines: string[] = [];
const expect = (name: string, got: number, want: number, tol: number) =>
  lines.push(`${Math.abs(got - want) <= tol ? "PASS" : "FAIL"} ${name}: ${got.toFixed(2)} (want ${want} ± ${tol})`);

const ref = kWeighted(997, -23, 5);
expect("997 Hz at -23 dBFS stereo", integrate(windows(ref)), -23, 0.1);
expect("997 Hz at 0 dBFS, one channel", lufs(windows(kWeighted(997, 0, 3, 1))[5]), -3.01, 0.1);
// A 20 dB quieter passage sits below the relative gate and is ignored.
const quiet = windows(kWeighted(997, -43, 5));
expect("relative gate drops a passage 20 LU down", integrate([...windows(ref), ...quiet]), -23, 0.1);
expect("absolute gate ignores silence", integrate([...windows(ref), ...new Array(40).fill(1e-9)]), -23, 0.1);
document.getElementById("out")!.textContent = "LOUDNESS\n" + lines.join("\n");
