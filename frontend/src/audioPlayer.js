// Collects streamed mp3 chunks between audio_start/audio_end, then plays them
// on the chosen output device (earbuds) via setSinkId.
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
    // Must be called from a user gesture so later playback is allowed.
    unlock() {
      el.muted = true;
      el.play().catch(() => {});
      el.muted = false;
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
