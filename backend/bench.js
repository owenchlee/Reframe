// Latency benchmark: runs the test client against the RUNNING server N times and reports
// p50 / worst for latencyMs and ttsMs, plus a per-stage breakdown per turn.
//
// Usage: node bench.js [runs=5] [--url ws://localhost:3001/live] [--enroll]
//   --enroll: each session first calibrates on a generated clip in the "me" voice (in memory), so
//   voice matching (embeddings per segment) is active, as in real use.
//
// Stages are measured from client-side event arrival (loopback, so within a few ms):
//   detect = their last word end -> engagement event (server's end-of-turn trigger)
//            (last word end = suggestion arrival - latencyMs, as computed by the server)
//   llm    = engagement -> suggestion (Groq)
//   tts    = suggestion -> first mp3 chunk
// Prints only numbers and suggestion modes, never transcript text.
const path = require('path');
const { runSession, loadPcm } = require('./test-client');
const { enrollmentPcm } = require('./test/enroll');

const CLIP = path.join(__dirname, 'test-clip.mp3');
const ME = [[0.0, 2.23], [8.58, 10.76]];

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) || 5);
const urlIdx = args.indexOf('--url');
const url = urlIdx >= 0 ? args[urlIdx + 1] : 'ws://localhost:3001/live';
const withEnroll = args.includes('--enroll');
const GAP_SECS = 1.5;

function analyze(events) {
  const turns = [];
  let lastEngagement = null;
  let cur = null;
  for (const e of events) {
    const m = e.msg;
    if (m && m.type === 'engagement') lastEngagement = e.t;
    else if (m && m.type === 'suggestion') {
      cur = { latencyMs: m.latencyMs, mode: m.mode, source: m.source || '-', tS: e.t, tE: lastEngagement, tA: null, ttsMs: null };
      turns.push(cur);
    } else if (e.binary && cur && cur.tA === null) cur.tA = e.t;
    else if (m && m.type === 'timing' && cur) cur.ttsMs = m.ttsMs;
  }
  return turns.map((t) => ({
    ...t,
    detect: t.tE === null ? null : Math.round(t.tE - (t.tS - t.latencyMs)),
    llm: t.tE === null ? null : Math.round(t.tS - t.tE),
    tts: t.tA === null ? null : Math.round(t.tA - t.tS),
  }));
}

const pct = (xs, p) => {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return '-';
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
};
const worst = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined);
  return v.length ? Math.max(...v) : '-';
};

(async () => {
  let pcm = loadPcm(CLIP);
  let me = ME;
  let controls = [];
  if (withEnroll) {
    const enroll = await enrollmentPcm();
    const enrollSec = enroll.length / 32000;
    const off = enrollSec + GAP_SECS;
    pcm = Buffer.concat([enroll, Buffer.alloc(Math.round(GAP_SECS * 32000)), pcm]);
    me = ME.map(([a, b]) => [a + off, b + off]);
    controls = [
      { at: 0, msg: { type: 'calibrate', action: 'start' } },
      { at: enrollSec + 0.1, msg: { type: 'calibrate', action: 'stop' } },
    ];
    console.log(`with enrollment: ${enrollSec.toFixed(2)}s calibration clip before the conversation`);
  }
  const all = [];
  for (let r = 1; r <= runs; r++) {
    const turns = analyze(await runSession({ pcm, me, url, controls }));
    turns.forEach((t, i) => all.push({ run: r, turn: i + 1, ...t }));
    const row = turns.map((t, i) => `turn${i + 1} lat ${t.latencyMs} (detect ${t.detect} + llm ${t.llm}) tts ${t.ttsMs ?? '-'} [${t.mode}/${t.source}]`);
    console.log(`run ${r}: ${turns.length} suggestions  ${row.join(' | ')}`);
  }

  const fields = ['latencyMs', 'ttsMs', 'detect', 'llm', 'tts'];
  const report = (label, rows) => {
    console.log(`\n${label} (n=${rows.length})`);
    for (const f of fields) {
      const xs = rows.map((x) => x[f]);
      console.log(`  ${f.padEnd(10)} p50 ${String(pct(xs, 0.5)).padStart(5)}   worst ${String(worst(xs)).padStart(5)}`);
    }
  };
  report('ALL TURNS', all);
  for (const turn of [...new Set(all.map((x) => x.turn))]) report(`TURN ${turn}`, all.filter((x) => x.turn === turn));
  for (const src of [...new Set(all.map((x) => x.source))]) report(`SOURCE ${src}`, all.filter((x) => x.source === src));
  const expected = runs * 2;
  if (all.length !== expected) console.log(`\nWARNING: expected ${expected} suggestions, got ${all.length}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
