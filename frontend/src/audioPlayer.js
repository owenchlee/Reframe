// Collects streamed mp3 chunks between audio_start/audio_end, then plays them
// on the chosen output device (earbuds) via setSinkId.
export function createPlayer() {
  const el = new Audio();
  let chunks = [];
  let sinkId = '';

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
    },
    push(buf) {
      chunks.push(buf);
    },
    async end() {
      if (!chunks.length) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
      chunks = [];
      await applySink();
      el.src = url;
      el.onended = () => URL.revokeObjectURL(url);
      try {
        await el.play();
      } catch (err) {
        console.warn('playback blocked', err.name);
      }
    },
    stop() {
      el.pause();
      chunks = [];
    },
  };
}
