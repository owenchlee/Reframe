// Collects streamed mp3 chunks between audio_start/audio_end, then plays them on the chosen
// output (earbuds). setSinkId only where supported; on phones the OS routes to connected earbuds.

// 16-bit mono WAV built in memory from float samples (-1..1). Nothing touches disk.
function wavBlob(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const SILENCE = () => wavBlob(new Float32Array(2205), 22050); // 0.1 s
// Two soft rising notes, so "test whisper" is easy to recognise in an earbud.
function testTone() {
  const rate = 22050;
  const out = new Float32Array(Math.round(rate * 0.7));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f = t < 0.3 ? 660 : 880;
    const local = t < 0.3 ? t : t - 0.35;
    const env = local < 0 ? 0 : Math.min(1, local / 0.02) * Math.min(1, Math.max(0, (0.3 - local) / 0.08));
    out[i] = 0.25 * env * Math.sin(2 * Math.PI * f * t);
  }
  return wavBlob(out, rate);
}

export function createPlayer() {
  const el = new Audio();
  let chunks = [];
  let sinkId = '';
  let gen = 0; // bumped by stop() so an in-flight end() can bail out
  let active = false; // between audio_start and audio_end: only then are chunks accepted

  async function applySink() {
    if (sinkId && typeof el.setSinkId === 'function') {
      try {
        await el.setSinkId(sinkId);
      } catch (err) {
        console.warn('setSinkId failed', err.name);
      }
    }
  }

  return {
    // Must be called synchronously inside a user gesture (the Start tap): playing real (silent)
    // audio on this element is what lets iOS play whispers on it later without a tap.
    unlock() {
      el.setAttribute('playsinline', '');
      const url = URL.createObjectURL(SILENCE());
      el.src = url;
      el.play().then(() => { el.pause(); }).catch(() => {}).finally(() => URL.revokeObjectURL(url));
    },
    // "Test whisper": a short tone through the same element and output as real whispers.
    async test() {
      const url = URL.createObjectURL(testTone());
      gen++;
      await applySink();
      el.src = url;
      el.onended = () => URL.revokeObjectURL(url);
      try {
        await el.play();
        return true;
      } catch (err) {
        console.warn('test playback blocked', err.name);
        return false;
      }
    },
    async setSink(id) {
      sinkId = id;
      await applySink();
    },
    begin() {
      chunks = [];
      active = true;
    },
    push(buf) {
      if (active) chunks.push(buf);
    },
    async end() {
      active = false;
      if (!chunks.length) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
      chunks = [];
      const myGen = ++gen;
      await applySink();
      // A stop() during the await above cancels this playback.
      if (myGen !== gen) {
        URL.revokeObjectURL(url);
        return;
      }
      el.src = url;
      el.onended = () => URL.revokeObjectURL(url);
      try {
        await el.play();
      } catch (err) {
        console.warn('playback blocked', err.name);
      }
    },
    // Stop immediately and drop queued chunks. No-op when nothing is playing or queued.
    stop() {
      gen++;
      chunks = [];
      active = false;
      if (!el.paused) el.pause();
    },
    get sinkSupported() {
      return typeof el.setSinkId === 'function';
    },
  };
}
