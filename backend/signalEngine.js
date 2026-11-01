// Signal engine: plain-JS engagement scoring. No LLM, no I/O, no logging.
// The engine decides the suggestion mode; Gemini only writes the line.

// ---- Thresholds (tune these for the demo) ----
// A reply from the other person under this many words counts as "short".
const SHORT_REPLY_WORDS = 5;
// This many consecutive short replies (with no questions and slow responses) => cold.
const COLD_CONSECUTIVE_SHORT = 2;
// The other person's average words over the last REPLY_WINDOW turns at/above this => engaged.
const ENGAGED_AVG_WORDS = 10;
// Number of the other person's recent turns used for the average reply length.
const REPLY_WINDOW = 3;
// Delay (ms) between the end of the user's turn and the start of their reply that counts as slow.
const SLOW_RESPONSE_MS = 2000;
// If the user's share of all words exceeds this, suggest asking a question instead of replying.
const USER_TALKS_TOO_MUCH_RATIO = 0.6;
// Turns kept in memory (only the last few are ever used).
const MAX_TURNS = 50;

const QUESTION_START = /^(what|why|how|when|where|who|which|do|does|did|are|is|was|were|have|has|can|could|would|will|should)\b/i;
const LAUGHTER = /[([]\s*(laugh|laughs|laughter|laughing|chuckle|chuckles|giggle|giggles)\s*[)\]]|\b(ha){2,}\b/i;

function countWords(text) {
  return text.replace(LAUGHTER, ' ').split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

function hasQuestion(text) {
  if (text.includes('?')) return true;
  return text.split(/[.!]\s+/).some((s) => QUESTION_START.test(s.trim()));
}

class SignalEngine {
  constructor() {
    this.turns = [];
  }

  // Add a finalized transcript segment. Consecutive segments from the same speaker are
  // merged into one turn. Times are in seconds on the session's audio timeline.
  // Returns the (possibly merged) turn.
  addSegment(who, text, startSec, endSec) {
    const last = this.turns[this.turns.length - 1];
    if (last && last.who === who) {
      last.text += ' ' + text;
      last.words = countWords(last.text);
      last.end = Math.max(last.end, endSec);
      last.hasQuestion = last.hasQuestion || hasQuestion(text);
      last.laughed = last.laughed || LAUGHTER.test(text);
      return last;
    }
    const turn = {
      who,
      text,
      words: countWords(text),
      start: startSec,
      end: endSec,
      hasQuestion: hasQuestion(text),
      laughed: LAUGHTER.test(text),
      // Response delay: only measured for their turns that directly follow a user turn.
      responseDelayMs: last && last.who === 'me' && who === 'them'
        ? Math.max(0, Math.round((startSec - last.end) * 1000))
        : null,
    };
    this.turns.push(turn);
    if (this.turns.length > MAX_TURNS) this.turns.shift();
    return turn;
  }

  talkRatio() {
    let me = 0;
    let total = 0;
    for (const t of this.turns) {
      total += t.words;
      if (t.who === 'me') me += t.words;
    }
    return total === 0 ? 0 : Math.round((me / total) * 100) / 100;
  }

  avgReplyLength() {
    const theirs = this.turns.filter((t) => t.who === 'them').slice(-REPLY_WINDOW);
    if (theirs.length === 0) return 0;
    return theirs.reduce((s, t) => s + t.words, 0) / theirs.length;
  }

  // Returns { state, talkRatio, avgReplyLength, reasons }.
  engagement() {
    const theirs = this.turns.filter((t) => t.who === 'them');
    const talkRatio = this.talkRatio();
    const avg = this.avgReplyLength();
    const reasons = [];

    // Trailing run of consecutive short replies from the other person.
    const shortRun = [];
    for (let i = theirs.length - 1; i >= 0 && theirs[i].words < SHORT_REPLY_WORDS; i--) {
      shortRun.push(theirs[i]);
    }
    const noQuestions = shortRun.every((t) => !t.hasQuestion);
    const slow = shortRun.some((t) => t.responseDelayMs !== null && t.responseDelayMs >= SLOW_RESPONSE_MS);

    if (shortRun.length >= COLD_CONSECUTIVE_SHORT && noQuestions && slow) {
      reasons.push(`${shortRun.length} short replies in a row`, 'no questions back', 'slow responses');
      return { state: 'cold', talkRatio, avgReplyLength: avg, reasons };
    }

    const last = theirs[theirs.length - 1];
    if (avg >= ENGAGED_AVG_WORDS) reasons.push('long replies');
    if (last && last.hasQuestion) reasons.push('asked a question');
    if (last && last.laughed) reasons.push('laughed');
    if (reasons.length > 0) return { state: 'engaged', talkRatio, avgReplyLength: avg, reasons };

    if (shortRun.length > 0) reasons.push('short reply');
    return { state: 'neutral', talkRatio, avgReplyLength: avg, reasons };
  }

  // The engine, not the LLM, picks the mode.
  mode(state, talkRatio) {
    if (state === 'cold') return 'exit';
    if (talkRatio > USER_TALKS_TOO_MUCH_RATIO) return 'ask';
    return 'reply';
  }

  recentTurns(n) {
    return this.turns.slice(-n).map((t) => ({ who: t.who, text: t.text }));
  }
}

module.exports = { SignalEngine, countWords, hasQuestion };
