// ElevenLabs streaming text-to-speech (mp3). Yields audio chunks as they arrive.
// Uses the shared keep-alive pool (httpClient.js): a fresh TLS connection per request was the
// main source of slow/variable first-chunk times.
const { request, warm } = require('./httpClient');

// Lowest-latency model per elevenlabs.io/docs/overview/models (~100ms).
const TTS_MODEL = 'eleven_flash_v2_5';
// Smallest mp3 format offered: fine for a whisper in earbuds and fewer bytes to stream.
const OUTPUT_FORMAT = 'mp3_22050_32';
// Default premade voice; override with ELEVENLABS_VOICE_ID in backend/.env.
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

async function* streamSpeech({ apiKey, voiceId, text, signal }) {
  const body = JSON.stringify({ text, model_id: TTS_MODEL });
  const res = await request(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId || DEFAULT_VOICE_ID}/stream?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, 'Content-Length': Buffer.byteLength(body) },
      body,
    },
  );
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`ElevenLabs TTS HTTP ${res.statusCode}`);
  }
  for await (const chunk of res) yield chunk;
}

// Opens/keeps a pooled TLS connection to ElevenLabs so the next TTS request skips the handshake.
function warmTts(apiKey) {
  return warm('https://api.elevenlabs.io/v1/models', { 'xi-api-key': apiKey });
}

module.exports = { streamSpeech, warmTts, TTS_MODEL };
