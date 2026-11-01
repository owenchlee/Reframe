// audio_stop scenarios. Needs the server running with real keys (node server.js).
// Run: npm run scenario:audio-stop
//
// A. "them" resumes while a whisper is playing: a scratch copy of test-clip.mp3 with a 1.0s
//    silence inserted mid-sentence in their first turn ("...a thrift store | downtown...").
//    The pause ends their turn early, a whisper starts, then they keep talking.
// B. The user presses the talk key while a whisper is playing: the plain test-clip.mp3 flow,
//    where "me" starts 1.2s after their turn ends.
// test-clip.mp3 itself is only read, never modified. Prints no transcript text.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runSession, loadPcm } = require('../test-client');

const CLIP = path.join(__dirname, '..', 'test-clip.mp3');
const PAUSE_AT = 5.2; // seconds into test-clip.mp3: boundary after "store" in their first turn
const PAUSE = 1.0;

function makePauseClip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reframe-stop-'));
  const out = path.join(dir, 'pause.wav');
  const fmt = 'aformat=sample_rates=44100:channel_layouts=mono';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', CLIP, '-f', 'lavfi', '-t', String(PAUSE), '-i', 'anullsrc=r=44100:cl=mono',
    '-filter_complex', `[0:a]${fmt},asplit[a][b];[a]atrim=0:${PAUSE_AT},asetpts=PTS-STARTPTS[x];[b]atrim=start=${PAUSE_AT},asetpts=PTS-STARTPTS[y];[1:a]${fmt}[s];[x][s][y]concat=n=3:v=0:a=1`,
    out]);
  return { dir, out };
}

// Protocol checks that must hold for every session.
function checkStops(events) {
  let started = false; // between audio_start and a terminal message
  let afterStop = false;
  for (const e of events) {
    const type = e.msg && e.msg.type;
    if (type === 'audio_start') {
      started = true;
      afterStop = false;
    } else if (type === 'audio_stop') {
      assert.ok(started || events.some((x) => x.t < e.t && x.msg && x.msg.type === 'audio_start'), 'audio_stop without an earlier audio_start');
      afterStop = true;
      started = false;
    } else if (afterStop) {
      assert.ok(!e.binary, `mp3 chunk arrived after audio_stop (t=${Math.round(e.t)}ms)`);
      assert.notStrictEqual(type, 'audio_end', 'audio_end arrived after audio_stop');
      assert.notStrictEqual(type, 'timing', 'timing arrived after audio_stop');
    } else if (type === 'audio_end') started = false;
  }
}

const stopsBetween = (events, fromSec, toSec) =>
  events.filter((e) => e.msg && e.msg.type === 'audio_stop' && e.t >= fromSec * 1000 && e.t < toSec * 1000);

(async () => {
  let failed = 0;
  const run = async (name, fn) => {
    try {
      console.log(`PASS  ${name}  ${await fn()}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  };

  const { dir, out } = makePauseClip();
  try {
    await run('A: them resumes mid-whisper -> audio_stop', async () => {
      // "me" turns shift by the inserted pause; the first one after their turn starts at 8.58 + PAUSE.
      const meStart = 8.58 + PAUSE;
      const events = await runSession({ url: process.env.LIVE_URL, pcm: loadPcm(out), me: [[0, 2.23], [meStart, 10.76 + PAUSE]] });
      checkStops(events);
      // A stop caused by them resuming must come before the user presses the talk key.
      const early = stopsBetween(events, PAUSE_AT, meStart);
      assert.ok(early.length >= 1, `expected an audio_stop between ${PAUSE_AT}s and ${meStart}s (them resuming), got none`);
      return `(audio_stop at ${early.map((e) => (e.t / 1000).toFixed(2) + 's').join(', ')})`;
    });

    await run('B: user presses talk key mid-whisper -> audio_stop', async () => {
      const events = await runSession({ url: process.env.LIVE_URL, pcm: loadPcm(CLIP), me: [[0, 2.23], [8.58, 10.76]] });
      checkStops(events);
      const atKey = stopsBetween(events, 8.5, 9.5);
      assert.ok(atKey.length >= 1, 'expected an audio_stop right after the talk key at 8.58s, got none');
      return `(audio_stop at ${atKey.map((e) => (e.t / 1000).toFixed(2) + 's').join(', ')})`;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
