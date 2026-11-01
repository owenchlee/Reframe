// Laptop mic -> 16kHz mono PCM frames. Audio is streamed only, never stored.
// deviceId: the chosen input (laptop mic); '' = system default.
export async function startMicCapture(onFrame, deviceId = '') {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-downsampler');
  node.port.onmessage = (e) => onFrame(e.data);
  source.connect(node);

  return async function stop() {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  };
}
