// Stuck detector + persona scenarios. Needs the server running with real keys and the default
// hold (REFRAME_STUCK_MS unset or 1500). Run: npm run scenario:stuck   (LIVE_URL=ws://... to override)
//
// A. 3s of silence after the second turn (their first reply): nobody answers, so the held line is
//    released ~1.5s after their last word; checks heldMs.
// B. The user answers within the hold: 0.6s cut from the gap after their first turn, so the user
//    starts ~0.9s after their last word (Deepgram's word end is ~0.3s before the audio ends, so the
//    plain clip's gap is ~1.5s, right at the threshold). Expect suggestion_dropped and no
//    audio_start. B1 with the talk key. B2 with no key: a calibrated session (enrollment clip in the
//    "me" voice, generated in memory), so the drop comes from speech detection / diarized words.
// C. {type:"help"} 0.9s after their last word releases the held line immediately (as soon as its
//    text is ready, if Groq hasn't answered yet).
// P. Persona: the same input written by different personas, side by side (calls Groq directly).
// Scratch clips are built in memory from test-clip.mp3 (only read, never modified).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { runSession, loadPcm } = require('../test-client');
const { writeSuggestion } = require('../suggest');
const { PERSONAS } = require('../personas');

const URL = process.env.LIVE_URL || 'ws://localhost:3001/live';
const STUCK_MS = 1500;
const CLIP = path.join(__dirname, '..', 'test-clip.mp3');
const THEM1_END = 7.38; // end of their first turn in test-clip.mp3
const SILENCE_AT = 7.9; // insert point between their turn and the user's reply (8.58)
const SILENCE = 3.0;

// test-clip.mp3 with SILENCE seconds of silence inserted at SILENCE_AT, decoded to PCM in memory.
function clipWithSilence() {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', CLIP, '-f', 'lavfi', '-t', String(SILENCE), '-i', 'anullsrc=r=16000:cl=mono',
    '-filter_complex', `[0:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,asplit[a][b];[a]atrim=0:${SILENCE_AT},asetpts=PTS-STARTPTS[x];[b]atrim=start=${SILENCE_AT},asetpts=PTS-STARTPTS[y];[1:a]aformat=sample_fmts=s16:channel_layouts=mono[s];[x][s][y]concat=n=3:v=0:a=1`,
    '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg failed building the silence clip');
  return r.stdout;
}

const CUT_FROM = 7.6; // B: cut [CUT_FROM, CUT_TO) out of the gap before the user's reply
const CUT_TO = 8.2;

// test-clip.mp3 with [CUT_FROM, CUT_TO) removed, decoded to PCM in memory.
function clipShortGap() {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', CLIP,
    '-filter_complex', `[0:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,asplit[a][b];[a]atrim=0:${CUT_FROM},asetpts=PTS-STARTPTS[x];[b]atrim=start=${CUT_TO},asetpts=PTS-STARTPTS[y];[x][y]concat=n=2:v=0:a=1`,
    '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg failed building the short-gap clip');
  return r.stdout;
}

// Enrollment clip in the "me" voice (George), generated with ElevenLabs and decoded in memory only.
async function enrollmentPcm() {
  const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: JSON.stringify({
      text: 'Hi, this is me calibrating the coach. I am going to read a few sentences out loud. The weather has been great lately.',
      model_id: 'eleven_flash_v2_5',
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'],
    { input: Buffer.from(await res.arrayBuffer()), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg decode failed');
  return r.stdout;
}

// Events for the cycle answering the first "them" turn that ends after `afterSec` (stream time).
function cycleAfter(events, afterMs) {
  const eng = of(events, 'engagement').filter((e) => e.t >= afterMs);
  if (!eng.length) return [];
  const end = eng[1] ? eng[1].t : Infinity;
  return events.filter((e) => e.t >= eng[0].t && e.t < end);
}

const of = (events, type) => events.filter((e) => e.msg && e.msg.type === type);
// Events for the first suggestion cycle: from the first engagement up to the next engagement.
function firstCycle(events) {
  const eng = of(events, 'engagement');
  if (!eng.length) return [];
  const end = eng[1] ? eng[1].t : Infinity;
  return events.filter((e) => e.t >= eng[0].t && e.t < end);
}

let failed = 0;
async function run(name, fn) {
  try {
    console.log(`PASS  ${name}  ${await fn()}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

(async () => {
  const silent = clipWithSilence();
  const short = clipShortGap();
  const cut = CUT_TO - CUT_FROM;
  const meShifted = [[0, 2.23], [8.58 + SILENCE, 10.76 + SILENCE]];

  await run('A: nobody answers -> released after the hold', async () => {
    const ev = firstCycle(await runSession({ url: URL, pcm: silent, me: meShifted }));
    const sug = of(ev, 'suggestion')[0];
    const timing = of(ev, 'timing')[0];
    assert.ok(sug, 'no suggestion delivered');
    assert.ok(!of(ev, 'suggestion_dropped').length, 'line was dropped');
    assert.ok(timing && typeof timing.msg.heldMs === 'number', 'timing.heldMs missing');
    const { latencyMs } = sug.msg;
    const { heldMs } = timing.msg;
    // Released ~STUCK_MS after their last word: latency (word end -> text ready) + held ~= STUCK_MS.
    const sinceWord = latencyMs + heldMs;
    assert.ok(Math.abs(sinceWord - STUCK_MS) < 250, `released ${sinceWord}ms after their last word, expected ~${STUCK_MS}`);
    return `(latencyMs ${latencyMs} + heldMs ${heldMs} = released ${sinceWord}ms after their last word; ttsMs ${timing.msg.ttsMs})`;
  });

  const enroll = await enrollmentPcm();
  const enrollSec = enroll.length / 32000;
  const offset = enrollSec + 1.5;
  const calibrated = Buffer.concat([enroll, Buffer.alloc(Math.round(1.5 * 32000)), short]);
  const calibrate = [{ at: 0, msg: { type: 'calibrate', action: 'start' } }, { at: enrollSec + 0.1, msg: { type: 'calibrate', action: 'stop' } }];
  for (const [name, opts, skipMs] of [
    ['B1: user answers in the hold (talk key)', { pcm: short, me: [[0, 2.23], [8.58 - cut, 10.76 - cut]] }, 0],
    // Skip the cycle for the user's own first line; the one we want follows their first turn (3.43s in).
    ['B2: user answers in the hold (no key, calibrated, speech detection)', { pcm: calibrated, me: [], controls: calibrate }, (offset + 3.43) * 1000],
  ]) {
    await run(`${name} -> suggestion_dropped`, async () => {
      const all = await runSession({ url: URL, ...opts });
      const ev = skipMs ? cycleAfter(all, skipMs) : firstCycle(all);
      const dropped = of(ev, 'suggestion_dropped')[0];
      assert.ok(dropped, 'expected suggestion_dropped for their first turn');
      assert.ok(!of(ev, 'audio_start').length, 'audio_start was sent for a dropped line');
      assert.ok(!of(ev, 'suggestion').length, 'suggestion was sent for a dropped line');
      assert.ok(!ev.some((e) => e.binary), 'mp3 chunks were sent for a dropped line');
      const userAt = (skipMs ? offset : 0) + 8.58 - cut;
      return `(dropped at ${(dropped.t / 1000).toFixed(2)}s, mode ${dropped.msg.mode}; user starts at ${userAt.toFixed(2)}s)`;
    });
  }

  await run('C: help releases the held line immediately', async () => {
    const helpAt = THEM1_END - 0.38 + 0.9; // Deepgram's last word ends ~0.38s before the audio does
    const ev = firstCycle(await runSession({ url: URL, pcm: silent, me: meShifted, controls: [{ at: helpAt, msg: { type: 'help' } }] }));
    const sug = of(ev, 'suggestion')[0];
    const timing = of(ev, 'timing')[0];
    assert.ok(sug && timing, 'no suggestion delivered');
    const { latencyMs } = sug.msg;
    const { heldMs } = timing.msg;
    const sinceWord = latencyMs + heldMs;
    // help is at ~+900ms (plus the ~300ms Deepgram word-end offset); the line goes out then, or as
    // soon as its text is ready if that is later. Either way, before the 1500ms hold would expire.
    assert.ok(latencyMs >= STUCK_MS || sinceWord < STUCK_MS - 150, `released ${sinceWord}ms after their last word; help didn't release it early`);
    assert.ok(heldMs < 600, `held ${heldMs}ms after help`);
    return `(help at ~+900ms: latencyMs ${latencyMs}, heldMs ${heldMs}, released ${sinceWord}ms after their last word)`;
  });

  // Persona: same conversation, different styles; plus exit mode to confirm the polite exit wins.
  const turns = [
    { who: 'me', text: "Hey, I like your jacket. Where'd you get it?" },
    { who: 'them', text: 'Thanks, I got it at a thrift store downtown. I love finding old stuff.' },
  ];
  const cold = [
    { who: 'me', text: 'So what kind of music are you into?' },
    { who: 'them', text: 'Not much.' },
    { who: 'me', text: 'Oh, cool. Seen any good movies lately?' },
    { who: 'them', text: 'No.' },
  ];
  console.log('\npersona   reply (engaged)                                              exit (cold)');
  for (const id of Object.keys(PERSONAS)) {
    const [reply, exit] = await Promise.all([
      writeSuggestion({ apiKey: process.env.GROQ_API_KEY, turns, state: 'engaged', mode: 'reply', persona: PERSONAS[id].style }),
      writeSuggestion({ apiKey: process.env.GROQ_API_KEY, turns: cold, state: 'cold', mode: 'exit', persona: PERSONAS[id].style }),
    ]);
    console.log(`${id.padEnd(9)} ${reply.padEnd(60)} ${exit}`);
  }

  console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
