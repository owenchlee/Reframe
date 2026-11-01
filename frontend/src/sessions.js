// On-device conversation summaries. Stats only: no transcript text, no audio, nothing sent anywhere.
const KEY = 'reframe.sessions.v1';
const MAX_SESSIONS = 200;
export const STATES = ['engaged', 'neutral', 'cold'];

export function loadSessions() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveSessions(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage unavailable: the report just won't persist */
  }
}

export function clearSessions() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// Accumulates seconds spent in each engagement state while a conversation runs.
export function createTracker(startedAt = Date.now()) {
  const secs = { engaged: 0, neutral: 0, cold: 0 };
  let current = null;
  let currentAt = startedAt;
  let talkRatio = null;
  let coachLines = 0;
  let exited = false;

  const close = (t) => {
    if (current) secs[current] += (t - currentAt) / 1000;
    currentAt = t;
  };

  return {
    startedAt,
    onEngagement(state, ratio, t = Date.now()) {
      close(t);
      if (STATES.includes(state)) current = state;
      if (typeof ratio === 'number') talkRatio = ratio;
    },
    onSuggestion(mode) {
      coachLines += 1;
      if (mode === 'exit') exited = true;
    },
    shares(t = Date.now()) {
      const s = { ...secs };
      if (current) s[current] += (t - currentAt) / 1000;
      return s;
    },
    finish(t = Date.now()) {
      close(t);
      return {
        id: String(startedAt),
        startedAt,
        durationSec: Math.round((t - startedAt) / 1000),
        shares: { engaged: secs.engaged, neutral: secs.neutral, cold: secs.cold },
        talkRatio,
        coachLines,
        exited,
      };
    },
  };
}

export function sumShares(sessions) {
  const total = { engaged: 0, neutral: 0, cold: 0 };
  for (const s of sessions) for (const k of STATES) total[k] += s.shares?.[k] || 0;
  return total;
}

// Whole-number percentages that add to 100 (largest remainder), or null with no data.
export function toPercents(shares) {
  const sum = STATES.reduce((a, k) => a + shares[k], 0);
  if (sum <= 0) return null;
  const raw = STATES.map((k) => (shares[k] / sum) * 100);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  raw
    .map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => {
      if (left-- > 0) floor[i] += 1;
    });
  return { engaged: floor[0], neutral: floor[1], cold: floor[2] };
}

export function avgTalkRatio(sessions) {
  let num = 0;
  let den = 0;
  for (const s of sessions) {
    if (typeof s.talkRatio === 'number') {
      num += s.talkRatio * s.durationSec;
      den += s.durationSec;
    }
  }
  return den > 0 ? num / den : null;
}

export function takeaway(s) {
  const pct = toPercents(s.shares || {});
  if (s.exited) return 'You wrapped up gracefully';
  if (!pct) return 'Not enough to read';
  if (pct.engaged >= 60) return 'They were into it';
  if (pct.cold >= 40) return 'It cooled off';
  return 'Steady throughout';
}
