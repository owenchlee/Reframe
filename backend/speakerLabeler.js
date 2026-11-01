// Speaker labeling: decides "me" vs "them" for each transcribed word. Plain JS, no I/O, no logging.
//
// Sources, strongest first:
//   1. Push-to-talk: while the user holds the talk key ({type:"speaker", who:"me"}), words are "me".
//   2. Diarization: after calibration, Deepgram's speaker index for the user's voice is "me";
//      any other or unknown index is "them".
//   3. Default: "them" (uncalibrated and no push-to-talk = the original behavior).
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

class SpeakerLabeler {
  constructor() {
    this.ptt = [{ at: 0, who: 'them' }]; // push-to-talk timeline (audio seconds)
    this.meLabel = null; // diarization index for the user, set by calibration
    this.calib = null; // { startSec, stopSec, durations: Map<label, seconds> }
    this.floor = null; // { who, lastEnd } holder of the floor after the last final word
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
  rawWho(w) {
    return this.pttAt(w.start) || this.diarWho(w);
  }

  // Label for an interim transcript: talk key held now -> "me", else the words' majority.
  labelPartial(words, nowSec) {
    if (this.pttAt(nowSec)) return 'me';
    if (!words.length) return this.floor ? this.floor.who : 'them';
    const me = words.filter((w) => this.rawWho(w) === 'me').length;
    return me * 2 > words.length ? 'me' : 'them';
  }

  // Labels for the words of one final result, in order. Updates the floor.
  labelFinal(words) {
    const labels = [];
    let prevEnd = this.floor ? this.floor.lastEnd : null;
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const continuing = this.floor && (group[0].start - this.floor.lastEnd) * 1000 <= FLOOR_HOLD_MS;
      const free = group.filter((w) => !this.pttAt(w.start)); // words not forced by push-to-talk
      const meCount = free.filter((w) => this.diarWho(w) === 'me').length;
      const themCount = free.length - meCount;
      const majority = meCount > themCount ? 'me' : 'them';
      let owner;
      if (!free.length) owner = 'me';
      else if (continuing) {
        const other = this.floor.who === 'me' ? themCount : meCount;
        const clearlyOther = other >= FLIP_MIN_WORDS && other / free.length >= FLIP_MIN_SHARE;
        owner = clearlyOther ? (this.floor.who === 'me' ? 'them' : 'me') : this.floor.who;
      } else owner = majority;
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

module.exports = { SpeakerLabeler, FLOOR_HOLD_MS };
