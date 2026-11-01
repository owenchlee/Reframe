// Runs the real public/pcm-worklet.js in a stub AudioWorklet scope and checks the 16kHz output.
// Run: npm test (from frontend/)
import assert from 'assert';
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(dir, '..', 'public', 'pcm-worklet.js'), 'utf8');

// Instantiate the worklet's processor at a given input rate.
function makeProcessor(rate) {
  let Cls = null;
  const ctx = {
    sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (b) => ctx.frames.push(new Int16Array(b)) }; } },
    registerProcessor: (name, c) => { Cls = c; },
    frames: [],
    Math, Int16Array, Float32Array,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { proc: new Cls(), frames: ctx.frames };
}

// Feed `seconds` of a sine at `freq` Hz, in 128-sample render quanta like a real AudioWorklet.
function run(rate, freq, seconds, amp = 0.5, channels = 1) {
  const { proc, frames } = makeProcessor(rate);
  const total = Math.round(rate * seconds);
  for (let off = 0; off < total; off += 128) {
    const n = Math.min(128, total - off);
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = amp * Math.sin((2 * Math.PI * freq * (off + i)) / rate);
    proc.process([Array.from({ length: channels }, () => ch)]);
  }
  const out = new Int16Array(frames.reduce((a, f) => a + f.length, 0));
  let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return { frames, out };
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + (v / 32768) ** 2, 0) / a.length);
// Dominant frequency via zero crossings (fine for a clean sine).
function freqOf(a, rate) {
  let z = 0;
  for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) z++;
  return (z / 2) / (a.length / rate);
}

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

for (const rate of [48000, 44100, 16000]) {
  test(`${rate} Hz in -> 16 kHz Int16 frames of 1600 samples, right length`, () => {
    const { frames, out } = run(rate, 440, 2);
    assert.ok(frames.length > 0 && frames.every((f) => f.length === 1600), 'frames must be 1600 samples (100 ms)');
    const expected = 2 * 16000;
    assert.ok(Math.abs(out.length - expected) <= 1600, `got ${out.length} samples for 2 s, expected ~${expected}`);
  });
  test(`${rate} Hz: a 440 Hz tone stays 440 Hz at the same level`, () => {
    const { out } = run(rate, 440, 2, 0.5);
    const f = freqOf(out, 16000);
    assert.ok(Math.abs(f - 440) < 5, `measured ${f.toFixed(1)} Hz`);
    const level = rms(out) / (0.5 / Math.SQRT2);
    assert.ok(level > 0.97 && level < 1.03, `level ratio ${level.toFixed(3)}`);
  });
  test(`${rate} Hz: speech-band 3 kHz passes (>= -2 dB)`, () => {
    const { out } = run(rate, 3000, 1, 0.5);
    const db = 20 * Math.log10(rms(out) / (0.5 / Math.SQRT2));
    assert.ok(db > -2, `3 kHz at ${db.toFixed(1)} dB`);
  });
}

for (const rate of [48000, 44100]) {
  test(`${rate} Hz: a 12 kHz tone (above the 8 kHz Nyquist) is attenuated, not passed through`, () => {
    const { out } = run(rate, 12000, 1, 0.5);
    const db = 20 * Math.log10(rms(out) / (0.5 / Math.SQRT2));
    assert.ok(db < -6, `12 kHz alias at ${db.toFixed(1)} dB`);
  });
}

test('stereo input is mixed to mono', () => {
  const { out } = run(48000, 440, 1, 0.5, 2);
  const level = rms(out) / (0.5 / Math.SQRT2);
  assert.ok(level > 0.97 && level < 1.03, `level ratio ${level.toFixed(3)}`);
});

test('full-scale input clips to the Int16 range without wrapping', () => {
  const { out } = run(48000, 440, 0.5, 1.5);
  assert.ok(Math.max(...out) === 32767 && Math.min(...out) === -32768, 'expected clipping at the Int16 limits');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
