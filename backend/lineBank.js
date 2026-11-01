// Per-conversation line bank. One LineBank per socket (LiveSession); state is in memory only and
// dies with the socket. Every pool of every persona is shuffled once at session start, and each
// line is served at most once per conversation. When a pool runs out, pickLine returns null and the
// caller falls back to the LLM. Never logs anything (lines are spoken to the user).
const { lines } = require('./lines');

// false = reply mode skips the bank and always uses the LLM (ask mode still uses the bank).
const BANK_FIRST_FOR_REPLIES = false;
// "ask" mode only uses the bank once the conversation has at least this many turns (both speakers).
// Before that the LLM asks a follow-up on the thread the other person opened (flow first).
const BANK_ASK_AFTER_TURNS = 8;
// How many delivered lines (bank or LLM) are kept for the LLM's "already said" list.
const SAID_MEMORY = 12;

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Which pool a situation draws from, or null when the bank is not used ("exit", unknown mode).
// turnCount: total turns so far; omitted = no flow-phase limit (used by tests of the pools themselves).
function poolKey({ mode, engagement, theyAsked, turnCount }) {
  const level = engagement === 'engaged' ? 'engaged' : 'neutral';
  if (mode === 'ask') return typeof turnCount === 'number' && turnCount < BANK_ASK_AFTER_TURNS ? null : ['ask', level];
  if (mode === 'reply') {
    if (!BANK_FIRST_FOR_REPLIES) return null;
    return ['reply', theyAsked ? 'asked' : level];
  }
  return null;
}

class LineBank {
  // rand is injectable for tests; defaults to Math.random.
  constructor(rand = Math.random) {
    this.pools = {};
    for (const [persona, kinds] of Object.entries(lines)) {
      this.pools[persona] = {};
      for (const [kind, groups] of Object.entries(kinds)) {
        this.pools[persona][kind] = {};
        for (const [group, list] of Object.entries(groups)) {
          this.pools[persona][kind][group] = shuffle(list, rand);
        }
      }
    }
    this.said = [];
  }

  // Next unused line for this situation, or null (pool exhausted, exit mode, unknown persona).
  pickLine({ persona, mode, engagement, theyAsked, turnCount }) {
    const key = poolKey({ mode, engagement, theyAsked, turnCount });
    const pool = key && this.pools[persona] && this.pools[persona][key[0]][key[1]];
    if (!pool || !pool.length) return null;
    return pool.shift();
  }

  // Remember a line the user was told (from the bank or the LLM).
  recordSaid(line) {
    if (!line) return;
    this.said.push(line);
    if (this.said.length > SAID_MEMORY) this.said.shift();
  }

  saidLines() {
    return this.said.slice();
  }
}

module.exports = { LineBank, BANK_FIRST_FOR_REPLIES, BANK_ASK_AFTER_TURNS, SAID_MEMORY, poolKey };
