// Diarization scenario: calibrate with a short clip in the "me" voice, then stream test-clip.mp3
// WITHOUT any speaker messages and score the me/them labels against the known turn times.
// Needs the server running with real keys. Run: npm run scenario:diarization [-- runs] [--url ws://...]
//   [--label name]  name printed on the summary line (e.g. diar-only / voice+diar)
//   [--forced]      the server runs with REFRAME_FORCE_SPEAKER=0 (diarization collapsed to one label):
//                   passes if every "them" (Sarah) turn is still labeled "them".
// Also prints offline voice similarity per turn (voice.js, same model as the server; enrollment on the
// whole calibration clip and the known turn spans, so numbers are close to, not equal to, the server's).
//
// The enrollment clip is generated with ElevenLabs TTS in the same voice as "me" in test-clip.mp3
// (George) and kept in memory only: nothing is written to disk. test-clip.mp3 is only read.
// Prints word counts and labels, never transcript text.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const path = require('path');
const { runSession, loadPcm } = require('../test-client');
const { enrollmentPcm } = require('./enroll');
const voice = require('../voice');

const GAP_SECS = 1.5; // silence between calibration and the conversation
// Known turns in test-clip.mp3 (seconds and script text), from make-test-clip.js.
const TURNS = [
  { who: 'me', start: 0.0, end: 2.23, text: "Hey, I like your jacket. Where'd you get it?" },
  { who: 'them', start: 3.43, end: 7.38, text: 'Thanks, I got it at a thrift store downtown. I love finding old stuff.' },
  { who: 'me', start: 8.58, end: 10.76, text: "Nice, what's the best thing you've found?" },
  { who: 'them', start: 11.96, end: 14.7, text: 'Honestly, a vintage denim jacket for ten bucks.' },
];
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
TURNS.forEach((t) => { t.words = new Set(norm(t.text)); });
// Match a final transcript to the script turn sharing the most words (robust to late arrivals).
function turnOf(text) {
  const ws = norm(text);
  let best = -1;
  let bestScore = 0;
  TURNS.forEach((t, i) => {
    const score = ws.filter((w) => t.words.has(w)).length / Math.max(1, ws.length);
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return bestScore >= 0.5 ? best : -1;
}

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) || 3);
const urlIdx = args.indexOf('--url');
const url = urlIdx >= 0 ? args[urlIdx + 1] : 'ws://localhost:3001/live';
const labelIdx = args.indexOf('--label');
const label = labelIdx >= 0 ? args[labelIdx + 1] : 'server';
const forced = args.includes('--forced');

// Offline similarity of each script turn to the enrollment clip (numbers only).
function offlineSims(enroll, clip) {
  if (!/is on/.test(voice.init())) return null;
  const e = new voice.VoiceMatcher();
  e.push(enroll);
  e.addEnrollWords([{ start: 0, end: enroll.length / 32000 }]);
  e.enroll();
  const c = new voice.VoiceMatcher();
  c.push(clip);
  c.me = e.me;
  return TURNS.map((t) => c.score([{ start: t.start, end: t.end }]));
}

(async () => {
  const enroll = await enrollmentPcm();
  const enrollSec = enroll.length / 32000;
  const clip = loadPcm(path.join(__dirname, '..', 'test-clip.mp3'));
  const offset = enrollSec + GAP_SECS;
  const pcm = Buffer.concat([enroll, Buffer.alloc(Math.round(GAP_SECS * 32000)), clip]);
  console.log(`enrollment ${enrollSec.toFixed(2)}s, conversation starts at ${offset.toFixed(2)}s, no speaker messages`);
  const sims = offlineSims(enroll, clip);
  if (sims) console.log('offline voice similarity per turn: ' + sims.map((r, i) => `turn${i + 1} ${TURNS[i].who} ${r ? r.sim.toFixed(3) : '-'} (${r ? r.ms.toFixed(0) : '-'}ms)`).join('  '));

  const totals = TURNS.map(() => ({ ok: 0, n: 0 }));
  let calibFails = 0;
  for (let r = 1; r <= runs; r++) {
    const events = await runSession({
      pcm,
      url,
      controls: [
        { at: 0, msg: { type: 'calibrate', action: 'start' } },
        { at: enrollSec + 0.1, msg: { type: 'calibrate', action: 'stop' } },
      ],
    });
    const cal = events.find((e) => e.msg && e.msg.type === 'calibrated');
    if (!cal || !cal.msg.ok) calibFails++;
    // Assign each final transcript (after calibration) to a script turn by its words.
    const calAt = cal ? cal.t : Infinity;
    const finals = events.filter((e) => e.msg && e.msg.type === 'transcript' && e.msg.final && e.t > calAt);
    const perTurn = TURNS.map(() => ({ ok: 0, n: 0 }));
    for (const f of finals) {
      const k = turnOf(f.msg.text);
      if (k < 0) continue;
      const words = f.msg.text.split(/\s+/).filter(Boolean).length;
      perTurn[k].n += words;
      if (f.msg.who === TURNS[k].who) perTurn[k].ok += words;
    }
    perTurn.forEach((p, i) => { totals[i].ok += p.ok; totals[i].n += p.n; });
    const calText = cal ? `calibrated ok=${cal.msg.ok}${cal.msg.reason ? ` (${cal.msg.reason})` : ''} at ${(cal.t / 1000).toFixed(2)}s` : 'no calibrated message';
    console.log(`run ${r}: ${calText} | ` + perTurn.map((p, i) => `turn${i + 1} ${TURNS[i].who} ${p.ok}/${p.n}`).join('  '));
  }

  console.log('\naccuracy per turn (words labeled correctly):');
  let ok = 0;
  let n = 0;
  totals.forEach((t, i) => {
    ok += t.ok;
    n += t.n;
    console.log(`  turn${i + 1} (${TURNS[i].who.padEnd(4)}) ${t.ok}/${t.n}  ${t.n ? ((100 * t.ok) / t.n).toFixed(0) : '-'}%`);
  });
  console.log(`  overall          ${ok}/${n}  ${n ? ((100 * ok) / n).toFixed(0) : '-'}%   calibration failures: ${calibFails}/${runs}   [${label}${forced ? ', forced single label' : ''}]`);
  if (forced) {
    const them = totals.filter((t, i) => TURNS[i].who === 'them');
    const themOk = them.every((t) => t.n > 0 && t.ok === t.n);
    console.log(`forced single label: Sarah turns labeled "them": ${themOk ? 'PASS' : 'FAIL'}`);
    process.exit(themOk && calibFails === 0 ? 0 : 1);
  }
  process.exit(ok === n && n > 0 && calibFails === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
