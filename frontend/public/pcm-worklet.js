// Mic input (any rate: 44.1k / 48k on phones) -> 16kHz mono Int16 PCM, posted in ~100ms chunks.
// Downsampling averages every input sample that falls inside each output interval (a box filter),
// which removes most content above 8kHz before decimating, so it doesn't fold back as noise.
// Stereo input is mixed down to mono. Tested by frontend/test/resampler.test.mjs.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms at 16kHz

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // input samples per output sample (e.g. 3 at 48k, 2.75625 at 44.1k)
    this.acc = 0; // sum of input samples (weighted) for the current output sample
    this.fill = 0; // how much of the current output interval has been covered, in input samples
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
  }

  emit(value) {
    const s = Math.max(-1, Math.min(1, value));
    this.out[this.outLen++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    if (this.outLen === CHUNK_SAMPLES) {
      this.port.postMessage(this.out.buffer.slice(0));
      this.outLen = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let x = input[0][i];
      if (input.length > 1) {
        for (let c = 1; c < input.length; c++) x += input[c][i];
        x /= input.length;
      }
      // This input sample covers one unit of time; split it across output intervals if needed.
      let remaining = 1;
      while (remaining > 0) {
        const room = this.step - this.fill;
        const take = Math.min(room, remaining);
        this.acc += x * take;
        this.fill += take;
        remaining -= take;
        if (this.fill >= this.step - 1e-9) {
          this.emit(this.acc / this.step);
          this.acc = 0;
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
