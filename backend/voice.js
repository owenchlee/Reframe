// Voice matching: "is this the user's voice?" using an open-source speaker-embedding model
// (sherpa-onnx, runs locally, no key). Per session: a rolling in-memory PCM buffer, the user's
// enrollment audio (from calibration) and their averaged embedding. Nothing is written to disk and
// nothing is logged here except one status line at startup. Audio and embeddings are dropped on close().
//
// Model: 3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx from the sherpa-onnx
// "speaker-recongition-models" release (3D-Speaker CAM++, trained on ~200k Chinese and English
// speakers). Chosen over the English-only VoxCeleb models after an offline comparison on 10 TTS
// segments (3 voices): best separation (same voice 0.77-0.84, others 0.14-0.37) and fastest (~50ms).
// Download: see CLAUDE.md ("How to run").
// On Linux the native addon may need LD_LIBRARY_PATH (npm start sets it).
const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, 'models', '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx');
const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;

// ---- Tunables ----
// Seconds of recent audio kept in memory for cutting segments out by word timestamps.
const BUFFER_SECONDS = 30;
// Calibration must yield at least this many seconds of spoken audio (word spans) to enroll.
const MIN_ENROLL_SECONDS = 4;
// Enrollment embeddings: windows of this length, this far apart, averaged. A trailing window
// shorter than ENROLL_MIN_WINDOW is dropped (unless it is the only one).
const ENROLL_WINDOW_SECONDS = 3;
const ENROLL_HOP_SECONDS = 1.5;
const ENROLL_MIN_WINDOW = 1.5;
// Padding around each word when cutting audio (word timestamps are tight), seconds.
const WORD_PAD = 0.05;
// A segment's vote uses at most its last this-many seconds of speech (embedding time grows with
// length: ~25ms for 2s, ~45ms for 3.6s on 2 threads; it runs before the end-of-turn trigger).
const MAX_SCORE_SECONDS = 3;
// ONNX threads for the embedding model (2 was fastest on a 12-core laptop; 4 was not faster).
const NUM_THREADS = 2;
// Never keep more than this much enrollment audio (later attempts keep adding to it).
const MAX_ENROLL_SECONDS = 30;

let extractor = null;
let status = 'off';

// Loads the model once per process (the model is read-only and shared by all sessions; per-session
// audio and embeddings live in VoiceMatcher). Returns a one-line status for the startup log.
function init() {
  if (process.env.REFRAME_VOICE === 'off') {
    status = 'voice matching is off (REFRAME_VOICE=off); using diarization only';
    return status;
  }
  if (!fs.existsSync(MODEL_PATH)) {
    status = `voice matching is off (model not found: models/${path.basename(MODEL_PATH)}); using diarization only`;
    return status;
  }
  try {
    const sherpa = require('sherpa-onnx-node');
    const t0 = Date.now();
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL_PATH, numThreads: NUM_THREADS, debug: false });
    status = `voice matching is on (${path.basename(MODEL_PATH)}, dim ${extractor.dim}, loaded in ${Date.now() - t0}ms)`;
  } catch (err) {
    extractor = null;
    status = 'voice matching is off (could not load sherpa-onnx; on Linux start with `npm start`, which sets LD_LIBRARY_PATH); using diarization only';
  }
  return status;
}

const available = () => extractor !== null;

function toFloat(buf) {
  const out = new Float32Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function embed(samples) {
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  const e = Float32Array.from(extractor.compute(stream));
  return normalize(e);
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // both are unit length
}

// Merge word spans (padded) into non-overlapping [start, end] ranges, in seconds.
function spans(words) {
  const out = [];
  for (const w of words) {
    const s = Math.max(0, w.start - WORD_PAD);
    const e = w.end + WORD_PAD;
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

class VoiceMatcher {
  constructor() {
    this.chunks = []; // [{ start: byte offset, buf }] most recent BUFFER_SECONDS
    this.endByte = 0;
    this.enrollPieces = []; // Float32Array pieces of the user's calibration speech
    this.enrollSamples = 0;
    this.me = null; // enrolled unit embedding
  }

  get enrolled() {
    return this.me !== null;
  }

  // PCM (16-bit mono, sample-aligned) in timeline order.
  push(buf) {
    this.chunks.push({ start: this.endByte, buf });
    this.endByte += buf.length;
    const keepFrom = this.endByte - BUFFER_SECONDS * BYTES_PER_SEC;
    while (this.chunks.length && this.chunks[0].start + this.chunks[0].buf.length < keepFrom) this.chunks.shift();
  }

  // PCM between two timeline seconds (clipped to what is still buffered), as floats.
  slice(startSec, endSec) {
    let a = Math.floor(startSec * SAMPLE_RATE) * 2;
    let b = Math.floor(endSec * SAMPLE_RATE) * 2;
    const parts = [];
    for (const c of this.chunks) {
      const cEnd = c.start + c.buf.length;
      if (cEnd <= a || c.start >= b) continue;
      parts.push(c.buf.subarray(Math.max(0, a - c.start), Math.min(c.buf.length, b - c.start)));
    }
    return toFloat(Buffer.concat(parts));
  }

  // Spoken audio of these words (word spans only, pauses removed).
  wordAudio(words) {
    const pieces = spans(words).map(([s, e]) => this.slice(s, e));
    const out = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of pieces) { out.set(p, off); off += p.length; }
    return out;
  }

  // ---- enrollment ----
  addEnrollWords(words) {
    if (!words.length) return;
    const audio = this.wordAudio(words);
    if (this.enrollSamples + audio.length > MAX_ENROLL_SECONDS * SAMPLE_RATE) return;
    this.enrollPieces.push(audio);
    this.enrollSamples += audio.length;
  }

  enrollSeconds() {
    return this.enrollSamples / SAMPLE_RATE;
  }

  resetEnrollAudio() {
    this.enrollPieces = [];
    this.enrollSamples = 0;
  }

  // Enroll from the collected audio. Returns { ok, windows, ms } or { ok:false } if too little.
  // On success the collected audio is released.
  enroll() {
    if (this.enrollSeconds() < MIN_ENROLL_SECONDS) return { ok: false };
    const t0 = Date.now();
    const all = new Float32Array(this.enrollSamples);
    let off = 0;
    for (const p of this.enrollPieces) { all.set(p, off); off += p.length; }
    const win = ENROLL_WINDOW_SECONDS * SAMPLE_RATE;
    const hop = ENROLL_HOP_SECONDS * SAMPLE_RATE;
    const embs = [];
    for (let s = 0; s < all.length; s += hop) {
      const e = Math.min(all.length, s + win);
      if (e - s < ENROLL_MIN_WINDOW * SAMPLE_RATE && embs.length) break;
      embs.push(embed(all.subarray(s, e)));
      if (e === all.length) break;
    }
    const mean = new Float32Array(embs[0].length);
    for (const v of embs) for (let i = 0; i < v.length; i++) mean[i] += v[i];
    this.me = normalize(mean);
    this.resetEnrollAudio();
    return { ok: true, windows: embs.length, ms: Date.now() - t0 };
  }

  // ---- scoring ----
  // Cosine similarity of these words' audio to the enrolled voice: { sim, ms, seconds }.
  // Returns null if not enrolled or the audio is gone from the buffer.
  score(words) {
    if (!this.me || !words.length) return null;
    const full = this.wordAudio(words);
    if (full.length < 0.3 * SAMPLE_RATE) return null;
    const audio = full.subarray(Math.max(0, full.length - MAX_SCORE_SECONDS * SAMPLE_RATE));
    const t = process.hrtime.bigint();
    const sim = cosine(this.me, embed(audio));
    return { sim, ms: Number(process.hrtime.bigint() - t) / 1e6, seconds: audio.length / SAMPLE_RATE };
  }

  close() {
    this.chunks = [];
    this.resetEnrollAudio();
    this.me = null;
  }
}

module.exports = { init, available, VoiceMatcher, cosine, MIN_ENROLL_SECONDS, MODEL_PATH, toFloat, embed: (s) => embed(s) };
