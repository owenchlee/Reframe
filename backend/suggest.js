// Groq suggestion writer (OpenAI-compatible chat completions). The signal engine picks the
// mode; this only writes the line. Never logs prompts or responses (they contain transcript text).

// Fastest usable model on this key (~400-600ms in testing) with reasoning turned off via REASONING_EFFORT.
const GROQ_MODEL = 'qwen/qwen3.8-27b';
const REASONING_EFFORT = 'none';
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
- exit: Them seems not interested. A polite, warm way to wrap up the conversation now. Do not try to keep it going.`;

function cleanLine(text) {
  const line = (text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const unquoted = line.replace(/^["'“‘]+|["'”’]+$/g, '').replace(/^(me|line|suggestion)\s*:\s*/i, '');
  const words = unquoted.split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_WORDS).join(' ');
}

async function writeSuggestion({ apiKey, turns, state, mode, signal }) {
  const transcript = turns.map((t) => `${t.who === 'me' ? 'Me' : 'Them'}: ${t.text}`).join('\n');
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Conversation so far:\n${transcript}\n\nEngagement: ${state}\nMode: ${mode}\nYour one line:` },
        ],
        temperature: 0.4,
        reasoning_effort: REASONING_EFFORT,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
    });
  } catch (err) {
    // Error messages here carry no request content; keep them generic anyway.
    if (timeout.aborted) throw new Error(`Groq timeout after ${TIMEOUT_MS}ms`);
    if (signal && signal.aborted) throw err;
    throw new Error('Groq network error');
  }
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  const line = cleanLine(data.choices?.[0]?.message?.content);
  if (!line) throw new Error('Groq returned no text');
  return line;
}

module.exports = { writeSuggestion, cleanLine, GROQ_MODEL };
