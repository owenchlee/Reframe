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

const SYSTEM_PROMPT = `You are a discreet, kind conversation coach for a shy person ("Me").
They are talking with someone ("Them"). Write ONE line Me can say next.
Rules:
- At most ${MAX_WORDS} words. One line. No quotes, no labels, no explanation.
- Sound natural and casual, like something a confident, friendly person would say.
- Build on what Them actually said. Never be pushy, manipulative, flirty-aggressive, or guilt-tripping.
Modes:
- ask: an open, curious question about something Them mentioned.
- reply: a short, warm response or relevant follow-up to Them's last turn.
- exit: Them seems not interested. A polite, warm way to wrap up the conversation now. Do not try to keep it going.
  Exit lines are always kind: no sarcasm, no jokes about Them, never comment on Them's mood, energy or
  interest, no guilt. Just a friendly goodbye that lets them go.
A persona style may be given. It only colors the wording. It never overrides these rules, and in
exit mode the polite wrap-up always wins over the style (keep the persona to a light, kind tone).`;

function cleanLine(text) {
  const line = (text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const unquoted = line.replace(/^["'“‘]+|["'”’]+$/g, '').replace(/^(me|line|suggestion)\s*:\s*/i, '');
  const words = unquoted.split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_WORDS).join(' ');
}

// Groq's response time varies a lot (measured 130-1150ms on a warm socket). If the first request
// hasn't answered after HEDGE_AFTER_MS, send an identical second one and take whichever finishes
// first. Costs at most one extra short completion per turn.
const HEDGE_AFTER_MS = 450;

// persona (optional): a style brief from personas.js.
async function writeSuggestion({ apiKey, turns, state, mode, persona, signal }) {
  const ctrls = [new AbortController(), new AbortController()];
  const abortAll = () => ctrls.forEach((c) => c.abort());
  if (signal) signal.addEventListener('abort', abortAll, { once: true });
  const attempt = (i) => requestLine({ apiKey, turns, state, mode, persona, signal: ctrls[i].signal });
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

async function requestLine({ apiKey, turns, state, mode, persona, signal }) {
  // Exit mode ignores the persona: in testing, the "funny" style still slipped in remarks about the
  // other person's mood in 2 of 5 exit lines despite the prompt rule. The polite exit always wins.
  if (mode === 'exit') persona = null;
  const transcript = turns.map((t) => `${t.who === 'me' ? 'Me' : 'Them'}: ${t.text}`).join('\n');
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Conversation so far:\n${transcript}\n\nEngagement: ${state}\nMode: ${mode}${persona ? `\nPersona style: ${persona}` : ''}\nYour one line:` },
    ],
    temperature: 0.4,
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

module.exports = { writeSuggestion, warmGroq, cleanLine, GROQ_MODEL };
