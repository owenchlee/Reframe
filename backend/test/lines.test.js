// Line bank tests: plain Node + assert, no API keys. Run: npm run test:lines (from backend/)
const assert = require('assert');
const { lines } = require('../lines');
const { LineBank, poolKey, BANK_FIRST_FOR_REPLIES, BANK_ASK_AFTER_TURNS } = require('../lineBank');
const { tooSimilar, cleanLine } = require('../suggest');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const PERSONAS = ['founder', 'charmer', 'listener', 'funny'];
const COUNTS = { ask: { engaged: 10, neutral: 10 }, reply: { asked: 6, engaged: 7, neutral: 7 } };
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const QUOTES = /["“”‘’`]/; // straight apostrophes inside words are allowed (contractions)

test('personas match', () => assert.deepStrictEqual(Object.keys(lines).sort(), [...PERSONAS].sort()));

for (const p of PERSONAS) {
  test(`${p}: exact pool counts`, () => {
    for (const [kind, groups] of Object.entries(COUNTS)) {
      assert.deepStrictEqual(Object.keys(lines[p][kind]).sort(), Object.keys(groups).sort(), `${kind} groups`);
      for (const [group, n] of Object.entries(groups)) {
        assert.strictEqual(lines[p][kind][group].length, n, `${kind}.${group}`);
      }
    }
  });
  test(`${p}: every line <= 15 words, no emoji, no quote characters, no leading/trailing apostrophe`, () => {
    for (const kind of Object.keys(COUNTS)) {
      for (const [group, list] of Object.entries(lines[p][kind])) {
        for (const line of list) {
          const where = `${kind}.${group}: ${line}`;
          assert.ok(line.split(/\s+/).filter(Boolean).length <= 15, `too long: ${where}`);
          assert.ok(!EMOJI.test(line), `emoji: ${where}`);
          assert.ok(!QUOTES.test(line), `quote: ${where}`);
          assert.ok(!/(^|\s)'|'(\s|$)/.test(line), `stray apostrophe: ${where}`);
          assert.strictEqual(cleanLine(line), line, `cleanLine would change: ${where}`);
        }
      }
    }
  });
  test(`${p}: no duplicates within the persona`, () => {
    const all = Object.values(lines[p]).flatMap((g) => Object.values(g).flat());
    assert.strictEqual(new Set(all.map((l) => l.toLowerCase())).size, all.length);
  });
}

const SITUATIONS = [
  { mode: 'ask', engagement: 'engaged', theyAsked: false, pool: ['ask', 'engaged'] },
  { mode: 'ask', engagement: 'neutral', theyAsked: true, pool: ['ask', 'neutral'] },
  { mode: 'reply', engagement: 'engaged', theyAsked: true, pool: ['reply', 'asked'] },
  { mode: 'reply', engagement: 'neutral', theyAsked: true, pool: ['reply', 'asked'] },
  { mode: 'reply', engagement: 'engaged', theyAsked: false, pool: ['reply', 'engaged'] },
  { mode: 'reply', engagement: 'neutral', theyAsked: false, pool: ['reply', 'neutral'] },
];

test('situation mapping (exit never uses the bank)', () => {
  for (const s of SITUATIONS) {
    assert.deepStrictEqual(poolKey(s), BANK_FIRST_FOR_REPLIES || s.mode === 'ask' ? s.pool : null, JSON.stringify(s));
  }
  for (const engagement of ['engaged', 'neutral', 'cold']) {
    assert.strictEqual(poolKey({ mode: 'exit', engagement, theyAsked: false }), null);
    assert.strictEqual(new LineBank().pickLine({ persona: 'founder', mode: 'exit', engagement, theyAsked: true }), null);
  }
});

for (const p of PERSONAS) {
  test(`${p}: picking until exhausted never repeats, covers the pool, then returns null`, () => {
    const bank = new LineBank();
    // Reply pools are only reachable when BANK_FIRST_FOR_REPLIES is true.
    const reachable = SITUATIONS.filter((x) => BANK_FIRST_FOR_REPLIES || x.mode === 'ask');
    for (const s of reachable.filter((x, i, a) => a.findIndex((y) => y.pool.join() === x.pool.join()) === i)) {
      const want = lines[p][s.pool[0]][s.pool[1]];
      const got = [];
      let line;
      while ((line = bank.pickLine({ persona: p, ...s })) !== null) got.push(line);
      assert.strictEqual(new Set(got).size, got.length, `repeat in ${s.pool.join('.')}`);
      assert.deepStrictEqual([...got].sort(), [...want].sort(), `coverage of ${s.pool.join('.')}`);
      assert.strictEqual(bank.pickLine({ persona: p, ...s }), null);
    }
  });
}

test('two sessions get different orders', () => {
  // Real Math.random: with 10! orders a collision across every pool is effectively impossible.
  const order = () => {
    const b = new LineBank();
    const out = [];
    let l;
    while ((l = b.pickLine({ persona: 'founder', mode: 'ask', engagement: 'engaged' })) !== null) out.push(l);
    return out.join('|');
  };
  const a = order();
  const different = [1, 2, 3].some(() => order() !== a);
  assert.ok(different, 'three new sessions all matched the first order');
});

test('persona switch uses separate state', () => {
  const bank = new LineBank();
  const s = { mode: 'ask', engagement: 'engaged', theyAsked: false };
  const founderFirst = bank.pickLine({ persona: 'founder', ...s });
  // Drain funny's pool fully; founder's remaining pool must be untouched.
  let n = 0;
  while (bank.pickLine({ persona: 'funny', ...s }) !== null) n++;
  assert.strictEqual(n, lines.funny.ask.engaged.length);
  const rest = [];
  let l;
  while ((l = bank.pickLine({ persona: 'founder', ...s })) !== null) rest.push(l);
  assert.strictEqual(rest.length, lines.founder.ask.engaged.length - 1);
  assert.ok(!rest.includes(founderFirst));
  assert.ok(rest.every((x) => lines.founder.ask.engaged.includes(x)));
});

test('ask mode skips the bank before BANK_ASK_AFTER_TURNS turns', () => {
  const bank = new LineBank();
  const s = { persona: 'founder', mode: 'ask', engagement: 'engaged' };
  assert.strictEqual(bank.pickLine({ ...s, turnCount: 0 }), null);
  assert.strictEqual(bank.pickLine({ ...s, turnCount: BANK_ASK_AFTER_TURNS - 1 }), null);
  assert.ok(lines.founder.ask.engaged.includes(bank.pickLine({ ...s, turnCount: BANK_ASK_AFTER_TURNS })));
});

test('unknown persona returns null', () => {
  assert.strictEqual(new LineBank().pickLine({ persona: 'nobody', mode: 'ask', engagement: 'engaged' }), null);
});

test('recordSaid keeps the last 12 lines', () => {
  const bank = new LineBank();
  for (let i = 1; i <= 15; i++) bank.recordSaid(`line ${i}`);
  const said = bank.saidLines();
  assert.strictEqual(said.length, 12);
  assert.strictEqual(said[0], 'line 4');
  assert.strictEqual(said[11], 'line 15');
});

test('LLM repeat guard: same first two words or >60% word overlap', () => {
  const said = ['Okay, that\'s actually really cool.', 'What made you decide to go for that?'];
  assert.ok(tooSimilar('Okay, that\'s wild.', said), 'same opening');
  assert.ok(tooSimilar('So what made you decide to go for it?', said), 'high overlap');
  assert.ok(!tooSimilar('Wait, how long did that take you?', said));
  // Only the last 6 said lines count.
  const old = ['Okay, that\'s actually really cool.', 'a', 'b', 'c', 'd', 'e', 'f'];
  assert.ok(!tooSimilar('Okay, that\'s wild.', old));
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
