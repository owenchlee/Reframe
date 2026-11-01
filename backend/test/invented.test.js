// Invented-fact guard tests: plain Node + assert, no API keys. Run: npm run test:invented (from backend/)
const assert = require('assert');
const { statesUserFact } = require('../suggest');

const MUST_REJECT = [
  'Still working the same desk, honestly.',
  'Same here, I did that last year.',
  'I work in marketing, so I get it.',
  'Ha, I live just down the road actually.',
  "I've been there twice, it's great.",
  'I was a barista for years.',
  'I used to do that every summer.',
  'I just got back from Lisbon.',
  "I'm in tech, nothing exciting. You?",
  'My job is way less fun than that.',
  'My friend does the exact same thing.',
  'Me too, I love hiking.',
  'Honestly, been there. How did it go?',
  "I’m from up north, so I get it.",
  'Just started a new job myself.',
  'Not yet, though it sounds amazing. What made it your favorite city so far?',
  "Nope, never. Is it worth it?",
  "I've never tried it. What's it like?",
];

const MUST_PASS = [
  'I love that, how did you get into it?',
  'Ha, good question. What about you?',
  'I like that. What made you pick it?',
  'I get that. What was the hardest part?',
  'I respect that a lot.',
  'I hear you. How are you feeling about it now?',
  "I'm curious, what's the story there?",
  "I'm glad it worked out.",
  "Okay, I'm jealous. Where was that?",
  "I'm impressed, that takes guts.",
  'I can tell that matters to you.',
  'Working on anything fun lately?',
  'Still at it, or did you move on?',
  'I just love that you did that.',
  'Ooh, tough one. What would you pick?',
];

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

for (const line of MUST_REJECT) check(`reject: ${line}`, () => assert.strictEqual(statesUserFact(line), true));
for (const line of MUST_PASS) check(`pass:   ${line}`, () => assert.strictEqual(statesUserFact(line), false));

// With a profile: first-person claims pass only if they share a distinctive word with the profile.
const PROFILE = 'Anime: Attack on Titan. My favorite Attack on Titan character is Levi.\nFood: ramen and sushi. I would eat ramen any day.';
check('profile: "Levi, no contest. Who\'s yours?" passes', () => assert.strictEqual(statesUserFact("Levi, no contest. Who's yours?", PROFILE), false));
check('profile: "My favorite is Levi, honestly." passes (supported)', () => assert.strictEqual(statesUserFact('My favorite is Levi, honestly.', PROFILE), false));
check("profile: \"I'd eat ramen any day. You?\" passes (supported)", () => assert.strictEqual(statesUserFact("I'd eat ramen any day. You?", PROFILE), false));
check('profile: "I work at Google." is rejected', () => assert.strictEqual(statesUserFact('I work at Google.', PROFILE), true));
check('profile: generic profile words do not count ("My friend loves anime too.")', () => assert.strictEqual(statesUserFact('My friend loves anime too.', PROFILE), true));
check('profile: unsupported answer is rejected ("My favorite is Naruto.")', () => assert.strictEqual(statesUserFact('My favorite is Naruto.', PROFILE), true));
check('empty profile: every case behaves exactly as with no profile', () => {
  for (const line of [...MUST_REJECT, ...MUST_PASS]) assert.strictEqual(statesUserFact(line, ''), statesUserFact(line), line);
});

// writeSuggestion retry flow with a fake Groq (no network): intercept httpClient.request.
const httpClient = require('../httpClient');
const { Readable } = require('stream');

function fakeGroq(answers) {
  const bodies = [];
  httpClient.request = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const content = answers[Math.min(bodies.length - 1, answers.length - 1)];
    const res = Readable.from([Buffer.from(JSON.stringify({ choices: [{ message: { content } }] }))]);
    res.statusCode = 200;
    return res;
  };
  return bodies;
}

(async () => {
  // suggest.js holds its own reference to request, so reload it after patching.
  const load = () => {
    delete require.cache[require.resolve('../suggest')];
    return require('../suggest');
  };
  const base = { apiKey: 'x', turns: [{ who: 'them', text: 'What do you do?' }], state: 'engaged', mode: 'reply', theyAsked: true, said: [] };

  async function flow(name, answers, fn) {
    const bodies = fakeGroq(answers);
    const s = load();
    try {
      await fn(s, bodies);
      passed++;
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }

  await flow('asked-question note is in the per-turn message', ['Ha, good question. What about you?'], async (s, bodies) => {
    assert.strictEqual(await s.writeSuggestion(base), 'Ha, good question. What about you?');
    assert.ok(bodies[0].messages[1].content.includes('They asked the user a question. Do not answer it'));
    assert.strictEqual(bodies.length, 1);
  });
  await flow('rejected line -> one retry with the invented-fact note, retry used', ['I work in sales. You?', 'Ha, good one. What about you?'], async (s, bodies) => {
    assert.strictEqual(await s.writeSuggestion(base), 'Ha, good one. What about you?');
    assert.strictEqual(bodies.length, 2);
    assert.ok(bodies[1].messages[1].content.includes('stated a fact about the user'));
  });
  await flow('rejected twice -> InventedFactError (turn skipped), no text in the message', ['I work in sales.', 'Me too, honestly.'], async (s, bodies) => {
    await assert.rejects(s.writeSuggestion(base), (err) => err.code === 'INVENTED_FACT' && !/sales|honestly/i.test(err.message));
    assert.strictEqual(bodies.length, 2);
  });
  await flow('profile: supported answer used as is; profile is in the system prompt; flow phase line sent', ['Levi, no contest. Who is yours?'], async (s, bodies) => {
    const line = await s.writeSuggestion({ ...base, profile: PROFILE, turnCount: 2 });
    assert.strictEqual(line, 'Levi, no contest. Who is yours?');
    assert.ok(bodies[0].messages[0].content.includes('ABOUT THE USER (the only facts you may state about the user):\n' + PROFILE));
    assert.ok(bodies[0].messages[1].content.includes('Flow phase: true'));
    assert.ok(bodies[0].messages[1].content.includes('Turns so far: 2'));
  });
  await flow('profile: unsupported claim -> retry with the profile note', ['I work at Google. You?', 'Ha, I am curious, what would you pick?'], async (s, bodies) => {
    assert.strictEqual(await s.writeSuggestion({ ...base, profile: PROFILE }), 'Ha, I am curious, what would you pick?');
    assert.ok(bodies[1].messages[1].content.includes('not in ABOUT THE USER'));
  });
  await flow('too similar but clean, retry invents -> first line kept', ['Okay, that is wild.', 'I did that too.'], async (s) => {
    const line = await s.writeSuggestion({ ...base, said: ['Okay, that is so cool.'] });
    assert.strictEqual(line, 'Okay, that is wild.');
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
