// Signal engine tests: plain Node + assert, no framework, no API keys.
// Run: npm run test:engine (from backend/)
const assert = require('assert');
const { SignalEngine } = require('../signalEngine');
const fixtures = require('./fixtures');

let failed = 0;

for (const fx of fixtures) {
  try {
    const engine = new SignalEngine();
    for (const [i, t] of fx.turns.entries()) {
      const turn = engine.addSegment(t.who, t.text, t.start, t.end);
      for (const [key, want] of Object.entries(t.derived || {})) {
        assert.strictEqual(turn[key], want, `turn ${i} ${key}: expected ${want}, got ${turn[key]}`);
      }
    }
    const got = engine.engagement();
    const mode = engine.mode(got.state, got.talkRatio);
    const { expect } = fx;
    assert.strictEqual(got.state, expect.state, `state: expected ${expect.state}, got ${got.state} (${got.reasons.join(', ')})`);
    assert.strictEqual(got.talkRatio, expect.talkRatio, `talkRatio: expected ${expect.talkRatio}, got ${got.talkRatio}`);
    assert.strictEqual(mode, expect.mode, `mode: expected ${expect.mode}, got ${mode}`);
    if (expect.reasons) assert.deepStrictEqual(got.reasons, expect.reasons, `reasons: got ${JSON.stringify(got.reasons)}`);
    console.log(`PASS  ${fx.name}  -> ${got.state}, talkRatio ${got.talkRatio}, mode ${mode}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${fx.name}\n      ${err.message}`);
  }
}

console.log(`\n${fixtures.length - failed}/${fixtures.length} passed`);
process.exit(failed ? 1 : 0);
