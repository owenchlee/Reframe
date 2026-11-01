// Gemini suggestion writer. The signal engine picks the mode; this only writes the line.
// Never logs prompts or responses (they contain transcript text).

// Fastest current Flash model per ai.google.dev/gemini-api/docs/models.
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
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
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [{ text: `Conversation so far:\n${transcript}\n\nEngagement: ${state}\nMode: ${mode}\nYour one line:` }],
        }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 256 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('');
  const line = cleanLine(text);
  if (!line) throw new Error('Gemini returned no text');
  return line;
}

module.exports = { writeSuggestion, cleanLine, GEMINI_MODEL };
