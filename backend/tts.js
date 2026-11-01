// ElevenLabs streaming text-to-speech (mp3). Yields audio chunks as they arrive.

// Lowest-latency model per elevenlabs.io/docs/overview/models (~100ms).
const TTS_MODEL = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'mp3_44100_128';
// Default premade voice; override with ELEVENLABS_VOICE_ID in backend/.env.
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

async function* streamSpeech({ apiKey, voiceId, text, signal }) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId || DEFAULT_VOICE_ID}/stream?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
    },
  );
  if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS HTTP ${res.status}`);
  for await (const chunk of res.body) yield Buffer.from(chunk);
}

module.exports = { streamSpeech, TTS_MODEL };
