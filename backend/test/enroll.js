// Shared test helper: a calibration clip in the "me" voice of test-clip.mp3 (George), generated with
// ElevenLabs TTS and decoded to 16kHz PCM in memory only. Nothing is written to disk.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { spawnSync } = require('child_process');

const ME_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // George: the "me" voice in test-clip.mp3
const ENROLL_TEXT = 'Hi, this is me calibrating the coach. I am going to read a few sentences out loud. '
  + 'The weather has been great lately and I have been walking a lot.';

async function enrollmentPcm() {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ME_VOICE}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: JSON.stringify({ text: ENROLL_TEXT, model_id: 'eleven_flash_v2_5' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}`);
  const mp3 = Buffer.from(await res.arrayBuffer());
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { input: mp3, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg decode failed');
  return r.stdout;
}

module.exports = { enrollmentPcm, ME_VOICE };
