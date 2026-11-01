// Live sample (real Groq): the default profile answering six questions from "them".
// Run: npm run sample:profile   At most MAX_CALLS Groq calls (hedges and retries included), at least
// GAP_MS apart; stops at the first HTTP 429 so a rate limit doesn't burn the rest of the budget.
// Prints the questions (fixtures) and the delivered lines, never the profile text.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const httpClient = require('../httpClient');

const MAX_CALLS = 8;
const GAP_MS = 1500;
const QUESTIONS = [
  "What's your favorite character in Attack on Titan?",
  'Do you watch anything good?',
  'What do you do?',
  'Do you like Drake?',
  "What's your favorite food?",
  "What's your favorite pasta shape?", // not in the profile: should deflect, invent nothing
];

const real = httpClient.request;
let calls = 0;
let last = 0;
let rateLimited = false;
let chain = Promise.resolve();
httpClient.request = (url, opts) => {
  const go = chain.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
    if (rateLimited || calls >= MAX_CALLS) throw new Error('call budget stopped');
    calls++;
    last = Date.now();
    const res = await real(url, opts);
    if (res.statusCode === 429) rateLimited = true;
    return res;
  });
  chain = go.catch(() => {});
  return go;
};

// Loaded after the patch so suggest.js picks up the gated request.
const { writeSuggestion, statesUserFact } = require('../suggest');
const { PERSONAS } = require('../personas');
const { loadDefaultProfile } = require('../profile');

(async () => {
  const profile = loadDefaultProfile().text;
  for (const q of QUESTIONS) {
    if (rateLimited || calls >= MAX_CALLS) {
      console.log(`Q: ${q}\n   -> (not run: ${rateLimited ? 'Groq rate limit (429)' : 'call budget used'})`);
      continue;
    }
    const before = calls;
    let line;
    try {
      line = await writeSuggestion({
        apiKey: process.env.GROQ_API_KEY,
        turns: [{ who: 'me', text: 'Hey, how is it going?' }, { who: 'them', text: q }],
        state: 'engaged', mode: 'reply', persona: PERSONAS.founder.style, reasons: ['asked a question'],
        theyAsked: true, said: [], profile, turnCount: 2,
      });
    } catch (err) {
      console.log(`Q: ${q}\n   -> (no line: ${err.message})  [calls ${calls - before}]`);
      continue;
    }
    console.log(`Q: ${q}\n   -> ${line}  [calls ${calls - before}, guard ${statesUserFact(line, profile) ? 'REJECT' : 'pass'}]`);
  }
  console.log(`\ngroq calls ${calls}/${MAX_CALLS}${rateLimited ? ' (stopped at HTTP 429)' : ''}`);
})();
