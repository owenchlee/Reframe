// Reframe backend: Express + WebSocket (/live) on one port.
// Protocol is defined in ../CLAUDE.md (source of truth).
// Privacy: audio is only held in memory while being forwarded; transcripts and audio are never logged.
require('dotenv').config({ quiet: true });
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { DeepgramStream, SAMPLE_RATE } = require('./deepgram');
const { SignalEngine } = require('./signalEngine');
const { SpeakerLabeler } = require('./speakerLabeler');
const { writeSuggestion, warmGroq } = require('./suggest');
const { streamSpeech, warmTts, MP3_BYTES_PER_SEC } = require('./tts');
const { PERSONAS, DEFAULT_PERSONA, isPersona } = require('./personas');
const { LineBank } = require('./lineBank');
const voice = require('./voice');
const { loadDefaultProfile, SessionProfile } = require('./profile');

const PORT = Number(process.env.PORT) || 3001; // PORT override is for running tests beside a dev server
// Stuck detector: the whisper is held (generated + buffered in memory) and only played if nobody
// has started speaking this long after the other person's last word. 0 = no hold, play at once.
const STUCK_MS = process.env.REFRAME_STUCK_MS !== undefined && process.env.REFRAME_STUCK_MS !== ''
  ? Math.max(0, Number(process.env.REFRAME_STUCK_MS) || 0)
  : 1500;
// Drop sensitivity. New speech must start at least this long after their last word to count as
// "someone answered" (Deepgram also reports SpeechStarted inside the tail of their own last word).
const DROP_MIN_GAP_MS = 300;
// Use Deepgram's SpeechStarted (VAD) to drop a held line. Tradeoff: it fires ~0.1-0.3s after speech
// starts, so the user answering is caught quickly, but any loud non-speech sound (cough, laugh,
// door, music) can also trigger it and drop a line the user actually needed (they can press help).
// false = drop only on transcribed words or the talk key: robust to noise, but words arrive ~1s
// after speech starts, so an answer that begins late in the hold may come after the release.
const DROP_ON_VAD = true;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16-bit mono PCM
const CONTEXT_TURNS = 6; // turns sent to Groq
const WARM_EVERY_MS = 1000; // check often; httpClient only warms a host after it has been idle ~4s
// After calibrate stop, wait at most this long for Deepgram to flush the last calibration words.
const CALIB_FLUSH_TIMEOUT_MS = 1500;
const PLAYBACK_SLACK_MS = 300; // added to the estimated whisper length before it counts as finished
const WALL_LOG_SECS = 120; // how much audio-time -> wall-time mapping to keep (numbers only)
// One console line per finalized segment with numbers only (word count, duration, diarization labels,
// voice similarity, final label, embedding ms). Never text.
const DEBUG_LABELS = true;
// Test only: force every Deepgram speaker label to this index (simulates collapsed diarization).
const FORCE_SPEAKER = process.env.REFRAME_FORCE_SPEAKER !== undefined && process.env.REFRAME_FORCE_SPEAKER !== ''
  ? Number(process.env.REFRAME_FORCE_SPEAKER) : null;
const KEEP_TALKING = 'Keep talking a little longer';

const { DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, GROQ_API_KEY, ELEVENLABS_VOICE_ID, PICOVOICE_ACCESS_KEY } = process.env;
if (PICOVOICE_ACCESS_KEY) console.log('[reframe] PICOVOICE_ACCESS_KEY is set but unused (Picovoice Eagle is not built; voice matching uses sherpa-onnx)');
console.log(`[reframe] ${voice.init()}`);
// Loaded once at startup. Only the source file name and length are logged, never the text.
const DEFAULT_PROFILE = loadDefaultProfile();
console.log(`[reframe] default profile: ${DEFAULT_PROFILE.source} (${DEFAULT_PROFILE.text.length} chars)`);
if (FORCE_SPEAKER !== null) console.log(`[reframe] TEST: all diarization labels forced to ${FORCE_SPEAKER}`);
for (const [name, val] of Object.entries({ DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, GROQ_API_KEY })) {
  if (!val) console.warn(`[reframe] ${name} is not set in backend/.env`);
}

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true }));
// The default "about me" profile (profile.local.txt, else profile.example.txt), for the client to show/edit.
app.get('/api/profile-default', (req, res) => res.json({ text: DEFAULT_PROFILE.text }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

function forceSpeaker(words) {
  if (FORCE_SPEAKER !== null && words) for (const w of words) w.speaker = FORCE_SPEAKER;
  return words;
}

class LiveSession {
  constructor(client) {
    this.client = client;
    this.engine = new SignalEngine();
    this.audioBytes = 0; // total PCM bytes received = position on the audio timeline
    this.carry = null; // odd trailing byte from a frame, kept to stay sample-aligned
    this.labeler = new SpeakerLabeler(); // me/them: push-to-talk, then voice match, then diarization
    // Rolling PCM buffer + enrolled voice, in memory only (null when voice matching is off).
    this.voice = voice.available() ? new voice.VoiceMatcher() : null;
    this.segIndex = 0; // finalized segment counter for DEBUG_LABELS
    this.wallLog = []; // [{ endSec, wall }] to convert audio time to wall-clock time
    // The current suggestion (see onTheirTurnEnd). Held lines wait for release; delivered lines are
    // kept after audio_end until their estimated playback end, so a stale whisper can still be stopped.
    this.current = null;
    this.persona = DEFAULT_PERSONA;
    // Hand-written lines first (each once per conversation), then the LLM. Memory only, per socket.
    this.bank = new LineBank();
    // "About me" facts the coach may state about the user. Memory only, per socket; never logged.
    this.profile = new SessionProfile(DEFAULT_PROFILE.text);

    // Open TLS connections to Groq and ElevenLabs now, not on the first suggestion.
    const warmAll = () => { warmGroq(GROQ_API_KEY); warmTts(ELEVENLABS_API_KEY); };
    warmAll();
    this.warmTimer = setInterval(warmAll, WARM_EVERY_MS);

    this.stt = new DeepgramStream(DEEPGRAM_API_KEY);
    this.stt.on('partial', (text, words) => {
      forceSpeaker(words);
      // The other person kept talking after the turn we're answering: drop that suggestion (and
      // any audio still streaming) so nothing stale is whispered; their next end-of-turn re-triggers.
      // Judged by word timestamps, not arrival time, so a late interim of the user's own words
      // can't cancel a whisper.
      const cur = this.current;
      const fresh = (w) => !this.labeler.inCalibration(w.start);
      if (cur && words.some((w) => w.start > cur.turnEnd && fresh(w) && this.labeler.rawWho(w) === 'them')) {
        this.cancelCurrent();
      } else if (cur && cur.held && words.some((w) => fresh(w) && w.start >= cur.turnEnd + DROP_MIN_GAP_MS / 1000)) {
        this.cancelCurrent(); // anyone started speaking during the hold
      }
      this.send({ type: 'transcript', who: this.labeler.labelPartial(words, this.audioSec), text, final: false });
    });
    this.stt.on('committed', (text, words) => this.onCommitted(text, forceSpeaker(words)));
    this.stt.on('endOfTurn', () => this.onEndOfTurn());
    this.stt.on('speechStarted', (ts) => {
      const cur = this.current;
      if (DROP_ON_VAD && cur && cur.held && typeof ts === 'number' && !this.labeler.inCalibration(ts)
        && ts >= cur.turnEnd + DROP_MIN_GAP_MS / 1000) {
        this.cancelCurrent();
      }
    });
    this.stt.on('upstreamError', (msg) => console.error(`[deepgram] ${msg}`));
    this.stt.on('warning', (msg) => console.warn(`[deepgram] ${msg}`));
    this.stt.on('error', (err) => {
      console.error(`[deepgram] connection error: ${err.message}`);
      this.client.close(1011, 'transcription unavailable');
    });
    this.stt.on('close', () => {
      if (this.client.readyState === this.client.OPEN) this.client.close(1011, 'transcription ended');
    });
  }

  get audioSec() {
    return this.audioBytes / BYTES_PER_SEC;
  }

  wallAt(sec) {
    const entry = this.wallLog.find((e) => e.endSec >= sec);
    return entry ? entry.wall - (entry.endSec - sec) * 1000 : Date.now();
  }

  send(obj) {
    if (this.client.readyState === this.client.OPEN) this.client.send(JSON.stringify(obj));
  }

  sendBinary(buf) {
    if (this.client.readyState === this.client.OPEN) this.client.send(buf, { binary: true });
  }

  onAudio(buf) {
    if (this.carry) {
      buf = Buffer.concat([this.carry, buf]);
      this.carry = null;
    }
    if (buf.length % 2) {
      this.carry = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    if (!buf.length) return;
    if (this.voice) this.voice.push(buf);
    this.audioBytes += buf.length;
    this.wallLog.push({ endSec: this.audioSec, wall: Date.now() });
    while (this.wallLog.length && this.wallLog[0].endSec < this.audioSec - WALL_LOG_SECS) this.wallLog.shift();
    this.stt.write(buf);
  }

  onControl(msg) {
    if (msg.type === 'speaker' && (msg.who === 'me' || msg.who === 'them')) {
      // The user started talking: stop any whisper and drop a suggestion still being written.
      if (this.labeler.setPtt(msg.who, this.audioSec) && msg.who === 'me') this.cancelCurrent();
    } else if (msg.type === 'calibrate' && msg.action === 'start') {
      this.cancelCurrent();
      this.labeler.startCalibration(this.audioSec);
    } else if (msg.type === 'calibrate' && msg.action === 'stop') {
      this.finishCalibration();
    } else if (msg.type === 'help') {
      // Release a held line now; ignored if none is held.
      const cur = this.current;
      if (cur && cur.held) {
        cur.releaseDue = true;
        this.tryRelease(cur);
      }
    } else if (msg.type === 'persona') {
      if (isPersona(msg.id)) this.persona = msg.id; // unknown id: keep the previous persona
      this.send({ type: 'persona_set', id: this.persona });
    } else if (msg.type === 'profile') {
      const chars = this.profile.set(msg.text); // null for non-strings: ignored, no reply
      if (chars !== null) this.send({ type: 'profile_set', ok: true, chars });
    }
  }

  // Ends calibration once Deepgram has flushed the words up to now (or after a timeout).
  finishCalibration() {
    if (!this.labeler.calib || this.labeler.calib.stopSec !== null) {
      if (!this.labeler.calib) this.send({ type: 'calibrated', ok: false, reason: 'calibration was not started' });
      return;
    }
    this.labeler.stopCalibration(this.audioSec);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.stt.off('flushed', finish);
      const { ok, reason } = this.finishVoiceCalibration();
      this.send(ok ? { type: 'calibrated', ok } : { type: 'calibrated', ok, reason });
    };
    const timer = setTimeout(finish, CALIB_FLUSH_TIMEOUT_MS);
    this.stt.on('flushed', finish);
    this.stt.finalize();
  }

  // Diarization calibration plus voice enrollment. With voice matching on, the amount of speech is
  // judged on the collected enrollment audio, which is kept across failed attempts so the next
  // attempt continues from it ("Keep talking a little longer"). Two voices still fails (and drops
  // the collected audio). Without voice matching: the labeler's result, unchanged.
  finishVoiceCalibration() {
    const prevMe = this.labeler.meLabel;
    const result = this.labeler.finishCalibration();
    if (!this.voice) return result;
    if (!result.ok && /more than one voice/.test(result.reason)) {
      this.voice.resetEnrollAudio();
      return result;
    }
    const secs = this.voice.enrollSeconds();
    if (secs === 0) return result; // nothing collected: the labeler's reason ("no speech heard") stands
    if (secs < voice.MIN_ENROLL_SECONDS) {
      this.labeler.meLabel = prevMe; // not calibrated yet: keep what was there before
      return { ok: false, reason: KEEP_TALKING };
    }
    const r = this.voice.enroll();
    this.labeler.voiceOn = this.voice.enrolled;
    this.labeler.floor = null;
    if (DEBUG_LABELS) console.log(`[labels] enrolled voice: ${secs.toFixed(1)}s speech, ${r.windows} windows, ${r.ms}ms`);
    return { ok: true };
  }

  // Label a final STT segment word by word (push-to-talk override, then calibrated diarization,
  // smoothed so a turn keeps one owner), then update the engine. Calibration speech is shown as
  // "me" but never enters the conversation.
  onCommitted(text, words) {
    if (words && words.length) {
      const calibWords = words.filter((w) => this.labeler.inCalibration(w.start));
      if (calibWords.length) {
        this.labeler.addCalibrationWords(calibWords);
        if (this.voice) this.voice.addEnrollWords(calibWords);
        this.send({ type: 'transcript', who: 'me', text: calibWords.map((w) => w.text.trim()).join(' '), final: true });
        words = words.filter((w) => !this.labeler.inCalibration(w.start));
        if (!words.length) return;
      }
    }
    let segments;
    if (words && words.length) {
      segments = [];
      const scoreFn = this.voice && this.voice.enrolled ? (ws) => this.voice.score(ws) : null;
      const labels = this.labeler.labelFinal(words, scoreFn);
      if (DEBUG_LABELS) this.logDecisions();
      for (const [i, w] of words.entries()) {
        const who = labels[i];
        const last = segments[segments.length - 1];
        if (last && last.who === who) {
          last.text += ' ' + w.text.trim();
          last.end = w.end;
        } else {
          segments.push({ who, text: w.text.trim(), start: w.start, end: w.end });
        }
      }
    } else {
      // No word timings: attribute to whoever holds the floor now.
      const end = this.audioSec;
      segments = [{ who: this.labeler.pttAt(end) || (this.labeler.floor ? this.labeler.floor.who : 'them'), text, start: end, end }];
    }

    for (const seg of segments) {
      this.send({ type: 'transcript', who: seg.who, text: seg.text, final: true });
      this.engine.addSegment(seg.who, seg.text, seg.start, seg.end);
    }
  }

  // Deepgram end of utterance (speech_final or UtteranceEnd). Run the pipeline if the other
  // person spoke last; latency is measured from the end of their last word.
  onEndOfTurn() {
    const last = this.engine.turns[this.engine.turns.length - 1];
    if (last && last.who === 'them') this.onTheirTurnEnd(last.end);
  }

  async onTheirTurnEnd(endSec) {
    const turnEndWall = this.wallAt(endSec);
    const { state, talkRatio, reasons } = this.engine.engagement();
    this.send({ type: 'engagement', state, talkRatio, reasons });
    const mode = this.engine.mode(state, talkRatio);

    // A newer turn supersedes any suggestion still being written, held or spoken.
    this.cancelCurrent();
    const ctrl = new AbortController();
    const hold = STUCK_MS > 0;
    const cur = {
      ctrl, turnEnd: endSec, mode,
      held: hold, // pending and not delivered (always false with STUCK_MS = 0)
      releaseDue: !hold, released: false, dropped: false, releaseTimer: null,
      text: null, source: null, latencyMs: null, textReadyAt: null, heldMs: 0,
      buffer: [], ttsDone: false, ttsMs: null,
      audioStarted: false, audioEnded: false, firstChunkAt: null, bytes: 0, stopped: false,
    };
    this.current = cur;
    if (hold) {
      // Release once STUCK_MS has passed since their last word, if nobody has spoken by then.
      cur.releaseTimer = setTimeout(() => {
        cur.releaseDue = true;
        this.tryRelease(cur);
      }, Math.max(0, turnEndWall + STUCK_MS - Date.now()));
    }

    // Bank first (never for exit): a hit skips Groq entirely.
    const theyAsked = this.engine.theyAskedLast();
    const turnCount = this.engine.turns.length; // both speakers (the engine keeps at most 50)
    const banked = this.bank.pickLine({ persona: this.persona, mode, engagement: state, theyAsked, turnCount });
    try {
      if (banked) {
        cur.text = banked;
        cur.source = 'bank';
      } else {
        cur.text = await writeSuggestion({
          apiKey: GROQ_API_KEY,
          turns: this.engine.recentTurns(CONTEXT_TURNS),
          state,
          mode,
          persona: PERSONAS[this.persona].style,
          reasons,
          theyAsked,
          said: this.bank.saidLines(),
          profile: this.profile.text,
          turnCount,
          signal: ctrl.signal,
        });
        cur.source = 'llm';
      }
    } catch (err) {
      // Status only, never the line or transcript text.
      if (ctrl.signal.aborted) { /* superseded */ } else if (err.code === 'INVENTED_FACT') console.warn(`[suggest] ${err.message}`);
      else console.error(`[groq] ${err.message}`);
      clearTimeout(cur.releaseTimer);
      if (this.current === cur) this.current = null;
      return;
    }
    if (ctrl.signal.aborted) return;
    cur.textReadyAt = Date.now();
    cur.latencyMs = Math.round(cur.textReadyAt - turnEndWall); // last word end -> text ready
    this.tryRelease(cur);

    // TTS starts right away even while held; chunks are buffered in memory until release.
    // ttsMs = suggestion text ready -> first mp3 chunk received (= sent, when not held).
    try {
      for await (const chunk of streamSpeech({ apiKey: ELEVENLABS_API_KEY, voiceId: ELEVENLABS_VOICE_ID, text: cur.text, signal: ctrl.signal })) {
        // Checked right before every send: once audio_stop or a drop happened, no chunk can follow.
        if (cur.stopped || cur.dropped || ctrl.signal.aborted) break;
        if (cur.ttsMs === null) cur.ttsMs = Date.now() - cur.textReadyAt;
        if (cur.released) this.sendChunk(cur, chunk);
        else cur.buffer.push(chunk);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) console.error(`[tts] ${err.message}`);
    }
    if (cur.stopped || cur.dropped) return; // audio_stop / suggestion_dropped are terminal
    cur.ttsDone = true;
    if (cur.released) this.finishAudio(cur);
    if (ctrl.signal.aborted && this.current === cur) this.current = null;
  }

  // Deliver a line once its release is due (timer, help, or no hold) and its text is ready.
  tryRelease(cur) {
    if (cur !== this.current || cur.released || cur.dropped || !cur.releaseDue || cur.text === null) return;
    clearTimeout(cur.releaseTimer);
    cur.released = true;
    cur.held = false;
    cur.heldMs = STUCK_MS > 0 ? Math.max(0, Date.now() - cur.textReadyAt) : 0;
    this.bank.recordSaid(cur.text);
    this.send({ type: 'suggestion', text: cur.text, mode: cur.mode, latencyMs: cur.latencyMs, source: cur.source });
    this.send({ type: 'audio_start' });
    cur.audioStarted = true;
    for (const chunk of cur.buffer) this.sendChunk(cur, chunk);
    cur.buffer = [];
    if (cur.ttsDone) this.finishAudio(cur);
  }

  sendChunk(cur, chunk) {
    if (cur.firstChunkAt === null) cur.firstChunkAt = Date.now();
    cur.bytes += chunk.length;
    this.sendBinary(chunk);
  }

  finishAudio(cur) {
    if (cur.stopped || cur.audioEnded) return;
    this.send({ type: 'audio_end' });
    cur.audioEnded = true;
    if (!cur.ctrl.signal.aborted && cur.ttsMs !== null) {
      this.send({ type: 'timing', latencyMs: cur.latencyMs, ttsMs: cur.ttsMs, heldMs: cur.heldMs });
    }
  }

  // Estimated wall time when the client finishes playing the current whisper.
  playbackEndsAt(cur) {
    if (cur.firstChunkAt === null) return 0;
    return cur.firstChunkAt + (cur.bytes / MP3_BYTES_PER_SEC) * 1000 + PLAYBACK_SLACK_MS;
  }

  // Cancel the current suggestion.
  // - Held (not delivered yet): discard it and its buffered audio, tell the client suggestion_dropped.
  // - Delivered and possibly still playing: audio_stop.
  // - Otherwise (no hold and nothing sent yet, or playback finished): cancel silently.
  cancelCurrent() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    clearTimeout(cur.releaseTimer);
    if (cur.held && !cur.released) {
      cur.dropped = true;
      cur.held = false;
      cur.buffer = [];
      this.send({ type: 'suggestion_dropped', mode: cur.mode });
    } else {
      const playing = cur.audioStarted && !cur.stopped && (!cur.audioEnded || Date.now() < this.playbackEndsAt(cur));
      if (playing) {
        cur.stopped = true; // set before anything else so the TTS loop sends no further chunks
        this.send({ type: 'audio_stop' });
      }
    }
    cur.ctrl.abort();
  }

  // Numbers only: segment index, words, duration, diarization label counts, similarity, label, ms.
  logDecisions() {
    for (const d of this.labeler.decisions) {
      const diar = Object.entries(d.diar).map(([k, v]) => `${k}:${v}`).join(',');
      console.log(`[labels] seg ${++this.segIndex} at ${d.start.toFixed(2)}s words ${d.words} dur ${d.duration.toFixed(2)}s diar {${diar}}${d.collapsed ? ' collapsed' : ''}`
        + ` sim ${d.sim === null ? '-' : d.sim.toFixed(3)} -> ${d.label} (${d.source}) embed ${d.embedMs === null ? '-' : `${d.embedMs.toFixed(0)}ms`}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.voice) this.voice.close(); // drop buffered audio and the enrolled embedding
    this.voice = null;
    clearInterval(this.warmTimer);
    if (this.current) {
      clearTimeout(this.current.releaseTimer);
      this.current.buffer = [];
      this.current.ctrl.abort();
    }
    this.stt.close();
  }
}

wss.on('connection', (client) => {
  if (!DEEPGRAM_API_KEY || !ELEVENLABS_API_KEY || !GROQ_API_KEY) {
    client.close(1011, 'server missing API keys (see backend/.env)');
    return;
  }
  const session = new LiveSession(client);
  client.on('message', (data, isBinary) => {
    if (isBinary) return session.onAudio(Buffer.isBuffer(data) ? data : Buffer.from(data));
    try {
      session.onControl(JSON.parse(data.toString()));
    } catch {
      // ignore malformed control messages
    }
  });
  client.on('close', () => session.close());
  client.on('error', () => session.close());
});

server.listen(PORT, () => console.log(`[reframe] listening on http://localhost:${PORT} (ws: /live), stuck hold ${STUCK_MS}ms`));
