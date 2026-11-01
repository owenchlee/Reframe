// Groq suggestion writer (OpenAI-compatible chat completions). The signal engine picks the
// mode; this only writes the line. Never logs prompts or responses (they contain transcript text).

// Fastest usable model on this key (~400-600ms in testing) with reasoning turned off via REASONING_EFFORT.
const GROQ_MODEL = 'qwen/qwen3.8-27b';
const REASONING_EFFORT = 'none';
const { request, readBody, warm } = require('./httpClient');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 5000;
const MAX_TOKENS = 40;
const MAX_WORDS = 15;

// Verbatim system prompt (do not edit wording without updating CLAUDE.md).
const SYSTEM_PROMPT = `You are a quiet voice in the ear of a real person who is in the middle of a conversation with someone they just met. They cannot look at a screen and they have about two seconds, so whatever you write they will say out loud almost word for word, in their own voice, to the person in front of them. Write exactly one line, 15 words or fewer, in plain spoken English: contractions, no emojis, no hashtags, no quotation marks, no lists, no stage directions, and no explanation of why you chose it. It has to sound like something a relaxed, socially comfortable 25-year-old would actually say at a bar, a party or a coffee line, never like an assistant, a pickup artist, a talk show host or a customer survey. Avoid stock phrases such as "that's fascinating", "I'd love to hear more", "tell me more about yourself", "what are your hobbies", "great question" and any compliment on looks. React to what the other person actually said, using their own words where it helps.

Read the situation before you write. The mode tells you what is needed. "reply" means react to or build on what they just said, or, if they asked the user something, answer it as described below. "ask" means the user has been doing most of the talking, so ask one easy, specific, open question that follows from what the other person said, not a generic change of subject. "exit" means they are checking out, so give a short, warm, no-pressure goodbye with no jokes, no persona flavor, no hooks and no attempt to extend the conversation. Match the persona's style brief, but never let it override the mode or the other person's comfort. If the other person is giving short answers, lower the stakes: an easier question, a lighter tone, less intensity. If they are lit up, follow the thread they opened instead of changing the subject. You will be given the lines the user has already said in this conversation: never repeat, reword or reuse the opening words, sentence shape or joke pattern of any of them, and vary the rhythm so consecutive lines do not start the same way. Never pressure, never flirt harder than they are, never push for contact details or a meetup unless they bring it up, and never comment on their body, looks, age, relationship status or anything they have not volunteered. If what they said is unclear or very short, prefer a light question over a clever line. Output only the line.

If the other person asks the user a question (favorites, tastes, opinions, what they do), answer it in the user's voice using the ABOUT THE USER section: specific, short, first person, then hand a small hook or question back about the same topic. Pick one detail, never list several. Example shape: Honestly Arrival, the ending still bugs me. You seen it? Only state facts from ABOUT THE USER. If it has nothing on the question, invent nothing: react with curiosity and hand the question back, for example: Ha, I'm curious what you'd pick. What's yours? Flow first: stay on the thread the other person opened. During the flow phase (the first FLOW_TURNS turns, given each time) answer what was asked, react to the specific thing they said, and ask a follow-up about that same topic. Never jump to an unrelated topic while the thread is alive. Pivot only when the thread is clearly exhausted, they give two short answers in a row, or the mode is "exit", and a pivot must bridge from something they said. Never reply with filler that ignores their question, such as sounds good, yeah cool or depends on the day, when they asked something answerable.`;

// Turns (both speakers) at the start of a conversation that count as the "flow phase": stay on the
// thread they opened, answer and follow up on the same topic. Passed to the LLM each turn.
const FLOW_TURNS = 6;

// System prompt plus the session's "about me" profile (the only facts the LLM may state about the user).
function systemPrompt(profile) {
  return `${SYSTEM_PROMPT.replace('FLOW_TURNS', String(FLOW_TURNS))}\n\nABOUT THE USER (the only facts you may state about the user):\n${profile || '(empty: you know nothing about the user, so state no facts about them)'}`;
}

const TEMPERATURE = 0.8;
// Repeat guard: compared against the last SIMILAR_WINDOW said lines. Too similar = same first two
// words, or more than MAX_OVERLAP of the new line's distinct words appear in a said line.
const SIMILAR_WINDOW = 6;
const MAX_OVERLAP = 0.6;
const RETRY_NOTE = 'Your last attempt was too similar to a line already said. Start differently, with a different opening word and sentence shape.';

// Invented-fact guard. The user has to stand behind every word, so an LLM line that states a fact
// about the user (their job, home, past, friends, "same here") is rejected. Phrases are matched as
// whole words, case-insensitive, curly apostrophes normalized.
// ALLOWED_FIRST_PERSON: reactions and feelings the user can always truthfully say. They are removed
// from the line before the rejected patterns are checked (so "I just love that" is fine).
const ALLOWED_FIRST_PERSON = [
  'i love', 'i like', 'i get that', 'i get it', 'i respect', 'i hear you', "i'm curious", "i'm glad",
  "i'm jealous", "i'm impressed", 'i can tell', 'i just love', "i'm a little jealous", "i'm invested",
];
// REJECTED_FIRST_PERSON: first-person claims of fact about the user. Checked anywhere in the line.
const REJECTED_FIRST_PERSON = [
  'i work', 'i worked', "i'm working", 'i live', 'i lived', "i'm living", "i've been", 'i was', 'i did',
  'i used to', 'i just', "i'm in", "i'm from", "i'm a", "i'm an", "i'm still", 'i still', "i'm studying",
  'i study', 'i studied', 'i went', 'i had', 'i have a', "i've got", 'i got', 'i grew up', 'i moved',
  'i started', 'i quit', 'i run', 'i own', 'i tried', 'i play', "i'm into", "i'm doing", 'i also',
  "i'm also", "i'm the same", "i'm married", "i'm single", "i've done", "i've tried",
  'my job', 'my work', 'my place', 'my friend', 'my friends', 'my boss', 'my wife', 'my husband',
  'my partner', 'my girlfriend', 'my boyfriend', 'my family', 'my mom', 'my dad', 'my brother',
  'my sister', 'my kids', 'my dog', 'my cat', 'my apartment', 'my house', 'my office', 'my company',
  'my team', 'my desk', 'my city', 'my hometown', 'my weekend', 'my day',
  'same here', 'me too', 'me neither', 'same with me', 'same for me', 'been there',
  // answers to "have you ever...?" questions
  "i haven't", "i've never", 'i never', 'i have been', 'never been', 'never have', 'not yet',
  // answers to "what's your favorite / do you watch...?" (the coach answers these from the profile)
  'my favorite', "my favorite's", 'my go-to', 'i watch', 'i listen', "i'd eat", "i'd pick", "i'm a big",
  'i go', "i'm all about", 'i prefer', 'i think', 'i build', "i'm building",
];
// REJECTED_SENTENCE_STARTS: claims with the "I" dropped ("Still working the same desk."). Only checked
// at the start of a sentence that is not a question, after optional fillers ("Honestly, ...").
const REJECTED_SENTENCE_STARTS = [
  'still', 'just got', 'just started', 'just moved', 'just finished', 'just quit', 'been', 'currently',
  'usually', 'working', 'living', 'studying', 'grew up', 'moved', 'started', 'used to', 'went',
  'nope', 'never', "haven't", 'not really',
];
const FILLERS = '(?:(?:ha|haha|oh|honestly|well|yeah|okay|ok|hm|hmm|mm|so|eh|nah|yep)[,.!]?\\s+)*';
const INVENTED_NOTE = 'Your last attempt stated a fact about the user. The user has to stand behind every word: do not say anything about their life, job, past or opinions. React in a few words and ask them something instead.';
const INVENTED_NOTE_PROFILE = 'Your last attempt stated something about the user that is not in ABOUT THE USER. Only state facts from that section; if it has nothing on this, react with curiosity and hand the question back.';
const ASKED_NOTE = 'They asked the user a question. Do not answer it and do not say anything about the user. React in a few words, then hand a question back.';
const ASKED_NOTE_PROFILE = 'They asked the user a question. If ABOUT THE USER answers it, answer in the user\'s voice with one specific detail from it, then hand a small question back on the same topic. If it does not, invent nothing: react with curiosity and hand the question back.';

// Profile support: with a non-empty profile, a line containing a first-person claim passes if it shares
// at least one distinctive content word (3+ letters, not in STOPWORDS, case-insensitive) with the profile.
// STOPWORDS also holds generic words that appear in profiles but prove nothing (love, favorite, friends...).
const STOPWORDS = new Set(`
  the and but for nor yet with from into onto than then that this these those there their they them what
  when where which while who whom whose why how all any both each few more most other some such only own
  same very can will just don't should now about above after again against below between during before
  over under once here out off too not are was were been being have has had having does did doing would
  could might must shall you your yours our ours mine myself his her hers its it's i'm i've i'd i'll
  i'd you're isn't wasn't aren't haven't didn't doesn't won't can't let's that's what's who's
  love like likes liked favorite favourite best good great fine think also really mostly sometimes
  thing things stuff part time day days now one first lot kind sort way pretty nothing crazy
  play watch watching listen eat go going get got make made want know see say said friend friends
  shows show movies movie music anime games game sports food gym hot takes take work job place home
  honestly yeah okay yes no not actually definitely probably maybe still always never ever every
`.split(/\s+/).filter(Boolean));

const profileWordCache = new Map();
function contentWords(text) {
  return (text || '').toLowerCase().replace(/[‘’]/g, "'").match(/[a-z0-9][a-z0-9'&]*[a-z0-9]|[a-z0-9]/g)?.map((w) => w.replace(/'s$/, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w)) || [];
}
function profileWords(profile) {
  if (!profileWordCache.has(profile)) {
    if (profileWordCache.size > 50) profileWordCache.clear();
    profileWordCache.set(profile, new Set(contentWords(profile)));
  }
  return profileWordCache.get(profile);
}
function supportedByProfile(line, profile) {
  if (!profile) return false;
  const known = profileWords(profile);
  return contentWords(line).some((w) => known.has(w));
}

const phraseRe = (list) => new RegExp(`(^|[^a-z'])(${list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z'])`, 'g');
const ALLOWED_RE = phraseRe(ALLOWED_FIRST_PERSON);
const REJECTED_RE = phraseRe(REJECTED_FIRST_PERSON);
const START_RE = new RegExp(`^${FILLERS}(${REJECTED_SENTENCE_STARTS.join('|')})(?![a-z'])`);

// True if the line states a fact about the user that the profile does not support (see the lists above).
// Empty profile: any first-person claim is rejected (the original behavior).
function statesUserFact(line, profile = '') {
  const text = (line || '').toLowerCase().replace(/[‘’]/g, "'").replace(ALLOWED_RE, '$1 ');
  REJECTED_RE.lastIndex = 0;
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [];
  const claim = REJECTED_RE.test(text) || sentences.some((sen) => !sen.trim().endsWith('?') && START_RE.test(sen.trim()));
  return claim && !supportedByProfile(line, profile);
}

class InventedFactError extends Error {
  constructor() {
    super('line rejected twice (stated a fact about the user); suggestion skipped');
    this.code = 'INVENTED_FACT';
  }
}

function cleanLine(text) {
  const line = (text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const unquoted = line
    .replace(/^(me|line|suggestion)\s*:\s*/i, '')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/["“”]/g, '') // no quote characters anywhere; apostrophes inside words stay
    .replace(/[‘’]/g, "'");
  const words = unquoted.split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_WORDS).join(' ');
}

// Groq's response time varies a lot (measured 130-1150ms on a warm socket). If the first request
// hasn't answered after HEDGE_AFTER_MS, send an identical second one and take whichever finishes
// first. Costs at most one extra short completion per turn.
const HEDGE_AFTER_MS = 450;

function words(line) {
  return (line || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}

// True if line is too close to any of the recent said lines (see SIMILAR_WINDOW / MAX_OVERLAP).
function tooSimilar(line, said) {
  const w = words(line);
  if (!w.length) return false;
  const set = new Set(w);
  return (said || []).slice(-SIMILAR_WINDOW).some((prev) => {
    const p = words(prev);
    if (w.length >= 2 && p.length >= 2 && w[0] === p[0] && w[1] === p[1]) return true;
    const pset = new Set(p);
    let shared = 0;
    for (const x of set) if (pset.has(x)) shared++;
    return shared / set.size > MAX_OVERLAP;
  });
}

// One line from the LLM. Optional context: persona (style brief from personas.js), reasons
// (engagement reasons), theyAsked (their last turn had a question), said (lines already said this
// conversation). Every line goes through two checks: the invented-fact guard (statesUserFact) and
// the repeat guard (tooSimilar). If either fails, one retry with a note. A line that states a user
// fact is never used: if the retry also does, throws InventedFactError (the caller skips the turn).
// A line that is only too similar is used anyway when the retry fails.
async function writeSuggestion(opts) {
  const first = await hedgedLine(opts);
  const invented = statesUserFact(first, opts.profile);
  const similar = tooSimilar(first, opts.said);
  if (!invented && !similar) return first;
  const inventedNote = opts.profile ? INVENTED_NOTE_PROFILE : INVENTED_NOTE;
  const notes = [invented && inventedNote, similar && RETRY_NOTE].filter(Boolean).join(' ');
  let second;
  try {
    second = await hedgedLine({ ...opts, retryNote: notes });
  } catch (err) {
    if ((opts.signal && opts.signal.aborted) || invented) throw err;
    return first;
  }
  if (!statesUserFact(second, opts.profile)) return second;
  if (!invented) return first;
  throw new InventedFactError();
}

async function hedgedLine({ signal, ...opts }) {
  const ctrls = [new AbortController(), new AbortController()];
  const abortAll = () => ctrls.forEach((c) => c.abort());
  if (signal) signal.addEventListener('abort', abortAll, { once: true });
  const attempt = (i) => requestLine({ ...opts, signal: ctrls[i].signal });
  try {
    const first = attempt(0);
    // The hedge only fires if the first request is still pending; it settles (rejects) on abort
    // or if the first request fails outright, so Promise.any never hangs.
    const hedge = new Promise((resolve, reject) => {
      const timer = setTimeout(() => attempt(1).then(resolve, reject), HEDGE_AFTER_MS);
      first.then(() => clearTimeout(timer), (err) => { clearTimeout(timer); reject(err); });
      ctrls[1].signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    // First success wins; fail only if both fail (or the caller aborted).
    const line = await Promise.any([first, hedge]);
    return line;
  } catch (err) {
    if (signal && signal.aborted) throw signal.reason || err;
    const reasons = err.errors || [err];
    throw reasons.find((e) => e && !/aborted/i.test(e.message)) || reasons[0];
  } finally {
    abortAll();
    if (signal) signal.removeEventListener('abort', abortAll);
  }
}

function buildUserMessage({ turns, state, mode, persona, reasons, theyAsked, said, retryNote, profile, turnCount }) {
  const transcript = turns.length
    ? turns.map((t) => `${t.who === 'me' ? 'me' : 'them'}: ${t.text}`).join('\n')
    : '(nothing yet)';
  const saidList = said && said.length ? said.map((l) => `- ${l}`).join('\n') : '(none yet)';
  const parts = [
    `Persona style brief: ${persona || '(none: plain, warm and natural)'}`,
    `Mode: ${mode}`,
    `Engagement: ${state}${reasons && reasons.length ? ` (${reasons.join(', ')})` : ''}`,
    `Did they just ask the user a question: ${theyAsked ? 'yes' : 'no'}`,
    ...(theyAsked ? [profile ? ASKED_NOTE_PROFILE : ASKED_NOTE] : []),
    ...(typeof turnCount === 'number'
      ? [`Turns so far: ${turnCount}`, `Flow phase: ${turnCount <= FLOW_TURNS ? 'true (stay on their thread, answer and follow up on the same topic)' : 'false'}`]
      : []),
    `Last turns (me = the user, them = the other person):\n${transcript}`,
    `Lines already said this conversation (already said, do not repeat or reword):\n${saidList}`,
  ];
  if (retryNote) parts.push(retryNote);
  parts.push('Your one line:');
  return parts.join('\n\n');
}

async function requestLine({ apiKey, turns, state, mode, persona, reasons, theyAsked, said, retryNote, profile, turnCount, signal }) {
  // Exit mode ignores the persona: in testing, the "funny" style still slipped in remarks about the
  // other person's mood in 2 of 5 exit lines despite the prompt rule. The polite exit always wins.
  if (mode === 'exit') persona = null;
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt(profile) },
      { role: 'user', content: buildUserMessage({ turns, state, mode, persona, reasons, theyAsked, said, retryNote, profile, turnCount }) },
    ],
    temperature: TEMPERATURE,
    reasoning_effort: REASONING_EFFORT,
    max_tokens: MAX_TOKENS,
    stream: false,
  });
  let res;
  let text;
  try {
    res = await request(GROQ_URL, {
      method: 'POST',
      signal,
      timeoutMs: TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    text = await readBody(res);
  } catch (err) {
    // Error messages here carry no request content; keep them generic anyway.
    if (err.code === 'TIMEOUT') throw new Error(`Groq timeout after ${TIMEOUT_MS}ms`);
    if (signal && signal.aborted) throw err;
    throw new Error('Groq network error');
  }
  if (res.statusCode !== 200) throw new Error(`Groq HTTP ${res.statusCode}`);
  const data = JSON.parse(text);
  const line = cleanLine(data.choices?.[0]?.message?.content);
  if (!line) throw new Error('Groq returned no text');
  return line;
}

// Opens/keeps a pooled TLS connection to Groq so the next suggestion skips the handshake.
function warmGroq(apiKey) {
  return warm('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${apiKey}` }, 2);
}

module.exports = { writeSuggestion, warmGroq, cleanLine, tooSimilar, statesUserFact, InventedFactError,
  ALLOWED_FIRST_PERSON, REJECTED_FIRST_PERSON, REJECTED_SENTENCE_STARTS, buildUserMessage, GROQ_MODEL, SYSTEM_PROMPT,
  systemPrompt, supportedByProfile, FLOW_TURNS, STOPWORDS };
