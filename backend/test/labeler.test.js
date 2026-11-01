// Speaker labeler tests: plain Node + assert, no API keys. Run: npm run test:labeler
const assert = require('assert');
const { SpeakerLabeler } = require('../speakerLabeler');

// words: [start, speakerIndex] pairs, each word 0.25s long.
const W = (pairs) => pairs.map(([start, speaker]) => ({ text: 'w', start, end: start + 0.25, speaker }));
const run = (s) => (Array.isArray(s) ? s : [s]);

const cases = [
  ['uncalibrated, no push-to-talk -> all "them" (original behavior)', () => {
    const l = new SpeakerLabeler();
    assert.deepStrictEqual(l.labelFinal(W([[0, 0], [0.3, 1], [0.6, 0]])), ['them', 'them', 'them']);
  }],
  ['uncalibrated + push-to-talk -> "me" exactly inside the held interval', () => {
    const l = new SpeakerLabeler();
    l.setPtt('me', 1.0);
    l.setPtt('them', 2.0);
    assert.deepStrictEqual(l.labelFinal(W([[0.2, 0], [1.1, 0], [1.6, 0], [2.4, 0]])), ['them', 'me', 'me', 'them']);
  }],
  ['calibration picks the dominant label as "me"', () => {
    const l = new SpeakerLabeler();
    l.startCalibration(0);
    l.addCalibrationWords(W([[0, 2], [0.3, 2], [0.6, 2], [0.9, 2], [1.2, 2], [1.5, 2], [1.8, 2], [2.1, 2]]));
    l.stopCalibration(2.5);
    assert.deepStrictEqual(l.finishCalibration(), { ok: true });
    assert.strictEqual(l.meLabel, 2);
    assert.deepStrictEqual(l.labelFinal(W([[5, 2], [5.3, 2]])), ['me', 'me']);
    assert.deepStrictEqual(l.labelFinal(W([[7, 0], [7.3, 0]])), ['them', 'them']);
    assert.deepStrictEqual(l.labelFinal(W([[9, 5]])), ['them'], 'unknown label is "them"');
  }],
  ['calibration fails with no speech, too little speech, or two voices', () => {
    let l = new SpeakerLabeler();
    l.startCalibration(0);
    assert.strictEqual(l.finishCalibration().ok, false);
    l = new SpeakerLabeler();
    l.startCalibration(0);
    l.addCalibrationWords(W([[0, 0], [0.3, 0]]));
    assert.strictEqual(l.finishCalibration().ok, false);
    l = new SpeakerLabeler();
    l.startCalibration(0);
    l.addCalibrationWords(W([[0, 0], [0.3, 0], [0.6, 0], [0.9, 0], [1.2, 0], [1.5, 1], [1.8, 1], [2.1, 1]]));
    const r = l.finishCalibration();
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /more than one voice/);
    assert.strictEqual(l.meLabel, null);
  }],
  ['majority wins inside a turn; a noisy word does not flip it', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    assert.deepStrictEqual(l.labelFinal(W([[0, 0], [0.3, 0], [0.6, 1], [0.9, 0]])), ['me', 'me', 'me', 'me']);
  }],
  ['floor is kept across a short pause even if the next final starts with stray labels', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.labelFinal(W([[0, 1], [0.3, 1], [0.6, 1]])); // them, ends 0.85
    // 0.4s later, two words labeled "me" then "them": not a clear flip -> stays "them"
    assert.deepStrictEqual(l.labelFinal(W([[1.25, 0], [1.55, 0], [1.85, 1]])), ['them', 'them', 'them']);
  }],
  ['fast turn-taking: a clear run of the other voice takes the floor within 700ms', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.labelFinal(W([[0, 1], [0.3, 1]])); // them, ends 0.55
    assert.deepStrictEqual(l.labelFinal(W([[0.9, 0], [1.2, 0], [1.5, 0], [1.8, 0]])), ['me', 'me', 'me', 'me']);
  }],
  ['after a pause over 700ms the new group is decided by its own majority', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.labelFinal(W([[0, 1], [0.3, 1]])); // ends 0.55
    assert.deepStrictEqual(l.labelFinal(W([[1.5, 0], [1.8, 1]])), ['them', 'them'], 'tie -> them');
    assert.deepStrictEqual(l.labelFinal(W([[3.0, 0], [3.3, 0]])), ['me', 'me']);
  }],
  ['push-to-talk overrides calibrated diarization', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.setPtt('me', 0);
    assert.deepStrictEqual(l.labelFinal(W([[0.2, 1], [0.5, 1]])), ['me', 'me']);
  }],
  // ---- voice matching (fake scorer: similarity chosen per test) ----
  ['voice: high similarity -> "me", low -> "them", regardless of diarization', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.voiceOn = true;
    // 1.25s segments (5 words), all diarized as the user's label 0
    const seg = (t) => W([[t, 0], [t + 0.25, 0], [t + 0.5, 0], [t + 0.75, 0], [t + 1.0, 0]]);
    assert.deepStrictEqual(l.labelFinal(seg(0), () => ({ sim: 0.8, ms: 1 })), Array(5).fill('me'));
    assert.deepStrictEqual(l.labelFinal(seg(3), () => ({ sim: 0.1, ms: 1 })), Array(5).fill('them'));
    assert.strictEqual(l.decisions[0].source, 'voice');
    assert.strictEqual(l.decisions[0].sim, 0.1);
  }],
  ['voice: short segments get no vote; in-between uses diarization when it is working', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.voiceOn = true;
    l.recentSpeakers = [0, 0, 0, 1, 1, 1]; // diarization has seen two voices
    let called = 0;
    const score = () => { called++; return { sim: 0.5, ms: 1 }; };
    l.labelFinal(W([[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1.0, 1]]), score); // them by diar (in-between)
    assert.strictEqual(l.decisions[0].source, 'diar');
    assert.deepStrictEqual(l.labelFinal(W([[3, 0], [3.25, 0]]), score), ['me', 'me'], 'short: diarization');
    assert.strictEqual(called, 1);
    assert.strictEqual(l.decisions[0].sim, null);
  }],
  ['voice: collapsed diarization -> in-between and short segments are "them"', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.voiceOn = true;
    const seg = (t) => W([[t, 0], [t + 0.25, 0], [t + 0.5, 0], [t + 0.75, 0], [t + 1.0, 0]]);
    assert.deepStrictEqual(l.labelFinal(seg(0), () => ({ sim: 0.9, ms: 1 })), Array(5).fill('me'));
    assert.deepStrictEqual(l.labelFinal(seg(3), () => ({ sim: 0.5, ms: 1 })), Array(5).fill('them'), 'in-between');
    assert.strictEqual(l.decisions[0].source, 'collapsed');
    assert.deepStrictEqual(l.labelFinal(W([[6, 0], [6.25, 0]]), () => ({ sim: 0.9, ms: 1 })), ['them', 'them'], 'short');
    assert.strictEqual(l.rawWho({ start: 9, speaker: 0 }), 'them');
  }],
  ['voice: collapsed, the user continuing after a short pause stays "me"', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.voiceOn = true;
    l.labelFinal(W([[0, 0], [0.25, 0], [0.5, 0], [0.75, 0], [1.0, 0]]), () => ({ sim: 0.9, ms: 1 })); // ends 1.25
    // 0.4s later, a short bit: continuity
    assert.deepStrictEqual(l.labelFinal(W([[1.65, 0], [1.9, 0]]), () => ({ sim: 0.5, ms: 1 })), ['me', 'me']);
    assert.strictEqual(l.decisions[0].source, 'continuity');
  }],
  ['voice: push-to-talk still overrides a low similarity', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    l.voiceOn = true;
    l.setPtt('me', 0);
    assert.deepStrictEqual(l.labelFinal(W([[0.2, 1], [0.5, 1], [0.8, 1], [1.1, 1]]), () => ({ sim: 0.0, ms: 1 })), Array(4).fill('me'));
  }],
  ['no scorer (voice off): collapsed diarization keeps the original behavior', () => {
    const l = new SpeakerLabeler();
    l.meLabel = 0;
    assert.deepStrictEqual(l.labelFinal(W([[0, 0], [0.25, 0], [0.5, 0], [0.75, 0], [1.0, 0]])), Array(5).fill('me'));
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
