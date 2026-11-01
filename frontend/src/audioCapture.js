// Mic -> 16kHz mono Int16 PCM frames (public/pcm-worklet.js). Audio is streamed only, never stored.

// Mic processing. Phones in a pocket pick up rustle and the whisper itself: keep all three on.
export const ECHO_CANCELLATION = true;
export const NOISE_SUPPRESSION = true;
export const AUTO_GAIN_CONTROL = true;

// Create (and resume) the capture AudioContext. Call this synchronously inside the Start tap:
// iOS only lets an AudioContext run if it was created/resumed in a user gesture.
export function createCaptureContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  ctx.resume().catch(() => {});
  return ctx;
}

// deviceId: '' = system default (on phones: the built-in mic, or the earbud mic when connected).
// Returns { stop, isRunning } where isRunning() is false once the browser has stopped the mic
// (track ended) or suspended the context, e.g. after the page was backgrounded.
export async function startMicCapture(onFrame, { deviceId = '', ctx } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: ECHO_CANCELLATION,
      noiseSuppression: NOISE_SUPPRESSION,
      autoGainControl: AUTO_GAIN_CONTROL,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });
  const ownCtx = !ctx;
  const audioCtx = ctx || createCaptureContext();
  await audioCtx.audioWorklet.addModule('/pcm-worklet.js');
  const source = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, 'pcm-downsampler');
  node.port.onmessage = (e) => onFrame(e.data);
  source.connect(node);
  const track = stream.getAudioTracks()[0];

  return {
    isRunning() {
      return Boolean(track && track.readyState === 'live' && audioCtx.state === 'running');
    },
    async stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      if (ownCtx) await audioCtx.close().catch(() => {});
    },
    ctx: audioCtx,
  };
}
