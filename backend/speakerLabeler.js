// Speaker labeling: decides "me" vs "them" for each transcribed word. Plain JS, no I/O, no logging.
//
// Sources, strongest first:
//   1. Push-to-talk: while the user holds the talk key ({type:"speaker", who:"me"}), words are "me".
//   2. Voice match (when the user's voice is enrolled, see voice.js): one vote per segment (group of
//      words) of at least MIN_SEGMENT_SECONDS. Similarity above ME_HIGH = "me", below THEM_LOW = "them".
//   3. Diarization: after calibration, Deepgram's speaker index for the user's voice is "me";
//      any other or unknown index is "them". Used for in-between votes and short segments, unless
//      diarization has collapsed to one label (then: "them", except a quick continuation of the user).
//   4. Default: "them" (uncalibrated and no push-to-talk = the original behavior).
// Then smoothing: each group of words (split at pauses > FLOOR_HOLD_MS) gets ONE owner by majority,
// and whoever holds the floor keeps it across short pauses, so a turn never flips mid-sentence.

// ---- Thresholds ----
// A pause longer than this ends the current speaker's hold on the floor.
const FLOOR_HOLD_MS = 700;
// Within a hold, the floor only changes hands if the new words are clearly someone else:
// at least this many words, and at least this share of them labeled as the other speaker.
// (Covers fast turn-taking, where replies often start < 700ms after the other person stops.)
const FLIP_MIN_WORDS = 3;
const FLIP_MIN_SHARE = 0.8;
// Calibration: the user must speak at least this long (seconds of words) for it to count.
const CALIB_MIN_SPEECH_SEC = 1.5;
// Calibration fails if a second diarization label has at least this share of the speech AND at
// least CALIB_SECOND_MIN_SEC seconds (someone else talked, or the diarizer split the user's voice).
const CALIB_SECOND_MAX_SHARE = 0.2;
const CALIB_SECOND_MIN_SEC = 0.5;
// ---- Voice match (only used when a scoreFn is passed to labelFinal, i.e. the user is enrolled) ----
// Cosine similarity to the enrolled voice (3D-Speaker CAM++, voice.js). Measured offline on TTS voices
// with a separate enrollment clip: same voice 0.77-0.84, other voices 0.14-0.37 (a second male voice
// 0.28-0.37). Real voices on a phone mic will score lower: tune with the [labels] log lines.
// Above ME_HIGH: "me". Below THEM_LOW: "them". In between: diarization decides (or the collapse rule).
const ME_HIGH = 0.5;
const THEM_LOW = 0.4;
// Segments with less speech than this (seconds, from first word start to last word end) get no vote:
// the embedding of a word or two is too noisy.
const MIN_SEGMENT_SECONDS = 1.0;
// Diarization counts as collapsed when, over the last COLLAPSE_WINDOW_WORDS final words, the second
// most common speaker label has less than COLLAPSE_MIN_SHARE of them (everyone got one label).
const COLLAPSE_WINDOW_WORDS = 60;
const COLLAPSE_MIN_SHARE = 0.1;

class SpeakerLabeler {
  constructor() {
    this.ptt = [{ at: 0, who: 'them' }]; // push-to-talk timeline (audio seconds)
    this.meLabel = null; // diarization index for the user, set by calibration
    this.calib = null; // { startSec, stopSec, durations: Map<label, seconds> }
    this.floor = null; // { who, lastEnd } holder of the floor after the last final word
    this.recentSpeakers = []; // diarization labels of the last COLLAPSE_WINDOW_WORDS final words
    this.voiceOn = false; // set by the server once the user's voice is enrolled
    this.decisions = []; // one entry per segment from the last labelFinal call (numbers only)
  }

  // True when diarization is giving (almost) everyone the same label.
  diarCollapsed() {
    const counts = new Map();
    for (const sp of this.recentSpeakers) counts.set(sp, (counts.get(sp) || 0) + 1);
    const ranked = [...counts.values()].sort((a, b) => b - a);
    if (ranked.length < 2) return true;
    return ranked[1] / this.recentSpeakers.length < COLLAPSE_MIN_SHARE;
  }

  noteSpeakers(words) {
    for (const w of words) {
      if (w.speaker === undefined || w.speaker === null) continue;
      this.recentSpeakers.push(w.speaker);
    }
    if (this.recentSpeakers.length > COLLAPSE_WINDOW_WORDS) {
      this.recentSpeakers.splice(0, this.recentSpeakers.length - COLLAPSE_WINDOW_WORDS);
    }
  }

  // ---- push-to-talk ----
  currentPtt() {
    return this.ptt[this.ptt.length - 1].who;
  }

  setPtt(who, atSec) {
    if (who === this.currentPtt()) return false;
    this.ptt.push({ at: atSec, who });
    if (this.ptt.length > 500) this.ptt.splice(1, 1);
    return true;
  }

  // "me" if the talk key was held at this time, else null (no override).
  pttAt(sec) {
    let who = this.ptt[0].who;
    for (const p of this.ptt) {
      if (p.at <= sec) who = p.who;
      else break;
    }
    return who === 'me' ? 'me' : null;
  }

  // ---- calibration ----
  startCalibration(atSec) {
    this.calib = { startSec: atSec, stopSec: null, durations: new Map() };
  }

  stopCalibration(atSec) {
    if (this.calib && this.calib.stopSec === null) this.calib.stopSec = atSec;
  }

  inCalibration(sec) {
    const c = this.calib;
    return Boolean(c && sec >= c.startSec && (c.stopSec === null || sec <= c.stopSec));
  }

  addCalibrationWords(words) {
    for (const w of words) {
      if (w.speaker === undefined || w.speaker === null) continue;
      const d = this.calib.durations;
      d.set(w.speaker, (d.get(w.speaker) || 0) + Math.max(0, w.end - w.start));
    }
  }

  // Returns { ok, reason? }. On success the dominant label becomes "me" for the session.
  // On failure the previous calibration (if any) is kept.
  finishCalibration() {
    const c = this.calib;
    this.calib = null;
    if (!c) return { ok: false, reason: 'calibration was not started' };
    const ranked = [...c.durations.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((s, [, d]) => s + d, 0);
    if (total === 0) return { ok: false, reason: 'no speech heard' };
    if (total < CALIB_MIN_SPEECH_SEC) return { ok: false, reason: 'not enough speech, keep talking a bit longer' };
    const second = ranked[1];
    if (second && second[1] >= CALIB_SECOND_MIN_SEC && second[1] / total >= CALIB_SECOND_MAX_SHARE) {
      return { ok: false, reason: 'more than one voice heard, calibrate alone' };
    }
    this.meLabel = ranked[0][0];
    this.floor = null;
    return { ok: true };
  }

  get calibrated() {
    return this.meLabel !== null;
  }

  // ---- labeling ----
  diarWho(w) {
    return this.meLabel !== null && w.speaker === this.meLabel ? 'me' : 'them';
  }

  // Per-word label before smoothing (used for interim results and the "they kept talking" check).
  // With voice matching on and diarization collapsed, the diarization label means nothing, so new
  // words count as "them" (so a whisper still stops when someone resumes talking).
  rawWho(w) {
    const ptt = this.pttAt(w.start);
    if (ptt) return ptt;
    if (this.voiceOn && this.diarCollapsed()) return 'them';
    return this.diarWho(w);
  }

  // Label for an interim transcript: talk key held now -> "me", else the words' majority.
  labelPartial(words, nowSec) {
    if (this.pttAt(nowSec)) return 'me';
    if (!words.length) return this.floor ? this.floor.who : 'them';
    const me = words.filter((w) => this.rawWho(w) === 'me').length;
    return me * 2 > words.length ? 'me' : 'them';
  }

  // Labels for the words of one final result, in order. Updates the floor.
  // scoreFn (optional, voice matching): (words) => { sim, ms } | null for one segment's words.
  // After the call, this.decisions holds one numbers-only record per segment for diagnostics.
  labelFinal(words, scoreFn = null) {
    const labels = [];
    this.decisions = [];
    let prevEnd = this.floor ? this.floor.lastEnd : null;
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const continuing = this.floor && (group[0].start - this.floor.lastEnd) * 1000 <= FLOOR_HOLD_MS;
      const free = group.filter((w) => !this.pttAt(w.start)); // words not forced by push-to-talk
      const meCount = free.filter((w) => this.diarWho(w) === 'me').length;
      const themCount = free.length - meCount;
      const majority = meCount > themCount ? 'me' : 'them';
      this.noteSpeakers(group);
      const duration = group[group.length - 1].end - group[0].start;
      // Only the words not forced by push-to-talk are scored, so their span is what must be long enough.
      const freeSpan = free.length ? free[free.length - 1].end - free[0].start : 0;
      const vote = scoreFn && freeSpan >= MIN_SEGMENT_SECONDS ? scoreFn(free) : null;
      const collapsed = this.diarCollapsed();
      let owner;
      let source;
      if (!free.length) { owner = 'me'; source = 'ptt'; }
      else if (vote && vote.sim > ME_HIGH) { owner = 'me'; source = 'voice'; }
      else if (vote && vote.sim < THEM_LOW) { owner = 'them'; source = 'voice'; }
      else if (scoreFn && collapsed) {
        // Diarization is useless here: "them", unless the user is simply continuing after a short pause.
        owner = continuing && this.floor.who === 'me' ? 'me' : 'them';
        source = continuing && this.floor.who === 'me' ? 'continuity' : 'collapsed';
      } else if (continuing) {
        const other = this.floor.who === 'me' ? themCount : meCount;
        const clearlyOther = other >= FLIP_MIN_WORDS && other / free.length >= FLIP_MIN_SHARE;
        owner = clearlyOther ? (this.floor.who === 'me' ? 'them' : 'me') : this.floor.who;
        source = 'diar';
      } else { owner = majority; source = 'diar'; }
      const diar = {};
      for (const w of group) diar[w.speaker ?? '?'] = (diar[w.speaker ?? '?'] || 0) + 1;
      this.decisions.push({
        start: group[0].start, words: group.length, duration, diar, collapsed,
        sim: vote ? vote.sim : null, embedMs: vote ? vote.ms : null, label: owner, source,
      });
      for (const w of group) labels.push(this.pttAt(w.start) || owner);
      const last = group[group.length - 1];
      this.floor = { who: labels[labels.length - 1], lastEnd: last.end };
      group = [];
    };
    for (const w of words) {
      if (prevEnd !== null && (w.start - prevEnd) * 1000 > FLOOR_HOLD_MS) {
        flush();
      }
      group.push(w);
      prevEnd = w.end;
    }
    flush();
    return labels;
  }
}

module.exports = { SpeakerLabeler, FLOOR_HOLD_MS, ME_HIGH, THEM_LOW, MIN_SEGMENT_SECONDS };
