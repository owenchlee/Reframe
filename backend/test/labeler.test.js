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
