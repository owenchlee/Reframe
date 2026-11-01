// Downsamples mic input to 16kHz mono Int16 PCM and posts ~100ms chunks to the main thread.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0; // fractional read position in the incoming stream
    this.carry = new Float32Array(0);
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    const buf = new Float32Array(this.carry.length + channel.length);
    buf.set(this.carry);
    buf.set(channel, this.carry.length);

    // Linear interpolation resample.
    while (this.pos + 1 < buf.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s = buf[i] * (1 - frac) + buf[i + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.outLen === CHUNK_SAMPLES) {
        this.port.postMessage(this.out.buffer.slice(0));
        this.outLen = 0;
      }
      this.pos += this.ratio;
    }

    const consumed = Math.floor(this.pos);
    this.carry = buf.slice(consumed);
    this.pos -= consumed;
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
