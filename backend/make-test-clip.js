// One-off: builds backend/test-clip.mp3, a fake two-voice conversation for testing /live
// without a microphone, then prints the matching test-client command.
// Run: node make-test-clip.js   (needs ELEVENLABS_API_KEY in backend/.env, ffmpeg + ffprobe)
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TTS_MODEL = 'eleven_flash_v2_5';
const VOICES = { me: 'JBFqnCBsd6RMkjVDRZzb', them: 'EXAVITQu4vr4xnSDxMaL' }; // built-in "George" / "Sarah"
const GAP_SECS = 1.2;
const OUT = path.join(__dirname, 'test-clip.mp3');
const SCRIPT = [
  { who: 'me', text: "Hey, I like your jacket. Where'd you get it?" },
  { who: 'them', text: 'Thanks, I got it at a thrift store downtown. I love finding old stuff.' },
  { who: 'me', text: "Nice, what's the best thing you've found?" },
  { who: 'them', text: 'Honestly, a vintage denim jacket for ten bucks.' },
];

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is not set in backend/.env');
  process.exit(1);
}

async function speak(text, voiceId, file) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id: TTS_MODEL }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function duration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out.toString());
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reframe-clip-'));
  try {
    const clips = [];
    for (const [i, line] of SCRIPT.entries()) {
      const mp3 = path.join(tmp, `turn${i}.mp3`);
      const file = path.join(tmp, `turn${i}.wav`);
      await speak(line.text, VOICES[line.who], mp3);
      // Decode to WAV so durations are exact (MP3 frame padding skews ffprobe's estimate).
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp3, '-ar', '44100', '-ac', '1', file]);
      clips.push({ ...line, file, dur: duration(file) });
      console.log(`turn ${i} (${line.who}): ${clips[i].dur.toFixed(2)}s`);
    }

    // Inputs: clip0, clip1, ... then one generated silence split into the gaps between turns.
    const args = ['-v', 'error', '-y'];
    for (const c of clips) args.push('-i', c.file);
    args.push('-f', 'lavfi', '-t', String(GAP_SECS), '-i', 'anullsrc=r=44100:cl=mono');
    const fmt = 'aformat=sample_rates=44100:channel_layouts=mono';
    const gaps = clips.length - 1;
    let filter = clips.map((_, i) => `[${i}:a]${fmt}[c${i}];`).join('');
    filter += `[${clips.length}:a]${fmt},asplit=${gaps}${Array.from({ length: gaps }, (_, i) => `[g${i}]`).join('')};`;
    filter += clips.map((_, i) => (i < gaps ? `[c${i}][g${i}]` : `[c${i}]`)).join('');
    filter += `concat=n=${clips.length + gaps}:v=0:a=1[out]`;
    args.push('-filter_complex', filter, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '128k', OUT);
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });

    // Turn times from the real clip durations.
    let t = 0;
    const ranges = [];
    for (const [i, c] of clips.entries()) {
      const start = t;
      const end = t + c.dur;
      console.log(`  ${c.who.padEnd(4)} ${start.toFixed(2)}s - ${end.toFixed(2)}s`);
      if (c.who === 'me') ranges.push(`${start.toFixed(2)}-${end.toFixed(2)}`);
      t = end + (i < gaps ? GAP_SECS : 0);
    }
    console.log(`\nwrote ${path.relative(process.cwd(), OUT) || OUT} (${duration(OUT).toFixed(2)}s, expected ${t.toFixed(2)}s)`);
    console.log(`\nnode test-client.js test-clip.mp3 --me ${ranges.join(',')} --play`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
