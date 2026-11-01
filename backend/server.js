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

const PORT = Number(process.env.PORT) || 3001; // PORT override is for running tests beside a dev server
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16-bit mono PCM
const CONTEXT_TURNS = 6; // turns sent to Groq
const WARM_EVERY_MS = 1000; // check often; httpClient only warms a host after it has been idle ~4s
// After calibrate stop, wait at most this long for Deepgram to flush the last calibration words.
const CALIB_FLUSH_TIMEOUT_MS = 1500;
const PLAYBACK_SLACK_MS = 300; // added to the estimated whisper length before it counts as finished
const WALL_LOG_SECS = 120; // how much audio-time -> wall-time mapping to keep (numbers only)

const { DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, GROQ_API_KEY, ELEVENLABS_VOICE_ID, PICOVOICE_ACCESS_KEY } = process.env;
if (!PICOVOICE_ACCESS_KEY) console.log('[reframe] voiceprint is off (PICOVOICE_ACCESS_KEY not set); using diarization only');
else console.log('[reframe] PICOVOICE_ACCESS_KEY is set, but voiceprint (Eagle) is not built yet; using diarization only');
for (const [name, val] of Object.entries({ DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, GROQ_API_KEY })) {
  if (!val) console.warn(`[reframe] ${name} is not set in backend/.env`);
}

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

class LiveSession {
  constructor(client) {
    this.client = client;
    this.engine = new SignalEngine();
    this.audioBytes = 0; // total PCM bytes received = position on the audio timeline
    this.carry = null; // odd trailing byte from a frame, kept to stay sample-aligned
    this.labeler = new SpeakerLabeler(); // me/them: push-to-talk override, then calibrated diarization
    this.wallLog = []; // [{ endSec, wall }] to convert audio time to wall-clock time
    // The current suggestion: { ctrl, turnEnd, audioStarted, audioEnded, firstChunkAt, bytes, stopped }.
    // Kept after audio_end until its estimated playback end, so a stale whisper can still be stopped.
    this.current = null;

    // Open TLS connections to Groq and ElevenLabs now, not on the first suggestion.
    const warmAll = () => { warmGroq(GROQ_API_KEY); warmTts(ELEVENLABS_API_KEY); };
    warmAll();
    this.warmTimer = setInterval(warmAll, WARM_EVERY_MS);

    this.stt = new DeepgramStream(DEEPGRAM_API_KEY);
    this.stt.on('partial', (text, words) => {
      // The other person kept talking after the turn we're answering: drop that suggestion (and
      // any audio still streaming) so nothing stale is whispered; their next end-of-turn re-triggers.
      // Judged by word timestamps, not arrival time, so a late interim of the user's own words
      // can't cancel a whisper.
      const cur = this.current;
      if (cur && words.some((w) => w.start > cur.turnEnd && !this.labeler.inCalibration(w.start) && this.labeler.rawWho(w) === 'them')) {
        this.cancelCurrent();
      }
      this.send({ type: 'transcript', who: this.labeler.labelPartial(words, this.audioSec), text, final: false });
    });
    this.stt.on('committed', (text, words) => this.onCommitted(text, words));
    this.stt.on('endOfTurn', () => this.onEndOfTurn());
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
      const { ok, reason } = this.labeler.finishCalibration();
      this.send(ok ? { type: 'calibrated', ok } : { type: 'calibrated', ok, reason });
    };
    const timer = setTimeout(finish, CALIB_FLUSH_TIMEOUT_MS);
    this.stt.on('flushed', finish);
    this.stt.finalize();
  }

  // Label a final STT segment word by word (push-to-talk override, then calibrated diarization,
  // smoothed so a turn keeps one owner), then update the engine. Calibration speech is shown as
  // "me" but never enters the conversation.
  onCommitted(text, words) {
    if (words && words.length) {
      const calibWords = words.filter((w) => this.labeler.inCalibration(w.start));
      if (calibWords.length) {
        this.labeler.addCalibrationWords(calibWords);
        this.send({ type: 'transcript', who: 'me', text: calibWords.map((w) => w.text.trim()).join(' '), final: true });
        words = words.filter((w) => !this.labeler.inCalibration(w.start));
        if (!words.length) return;
      }
    }
    let segments;
    if (words && words.length) {
      segments = [];
      const labels = this.labeler.labelFinal(words);
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

    // A newer turn supersedes any suggestion still being written or spoken.
    this.cancelCurrent();
    const ctrl = new AbortController();
    const cur = { ctrl, turnEnd: endSec, audioStarted: false, audioEnded: false, firstChunkAt: null, bytes: 0, stopped: false };
    this.current = cur;

    let text;
    try {
      text = await writeSuggestion({
        apiKey: GROQ_API_KEY, turns: this.engine.recentTurns(CONTEXT_TURNS), state, mode, signal: ctrl.signal,
      });
    } catch (err) {
      if (!ctrl.signal.aborted) console.error(`[groq] ${err.message}`);
      return;
    }
    if (ctrl.signal.aborted) return;
    const latencyMs = Math.round(Date.now() - turnEndWall);
    this.send({ type: 'suggestion', text, mode, latencyMs });

    // ttsMs = suggestion text ready -> first mp3 chunk sent (what the user waits to hear).
    const ttsStart = Date.now();
    let ttsMs = null;
    this.send({ type: 'audio_start' });
    cur.audioStarted = true;
    try {
      for await (const chunk of streamSpeech({ apiKey: ELEVENLABS_API_KEY, voiceId: ELEVENLABS_VOICE_ID, text, signal: ctrl.signal })) {
        // Checked right before every send: once audio_stop went out, no chunk can follow it.
        if (cur.stopped || ctrl.signal.aborted) break;
        if (ttsMs === null) ttsMs = Date.now() - ttsStart;
        if (cur.firstChunkAt === null) cur.firstChunkAt = Date.now();
        cur.bytes += chunk.length;
        this.sendBinary(chunk);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) console.error(`[tts] ${err.message}`);
    }
    if (cur.stopped) return; // audio_stop is terminal: no audio_end, no timing
    this.send({ type: 'audio_end' });
    cur.audioEnded = true;
    if (!ctrl.signal.aborted && ttsMs !== null) this.send({ type: 'timing', latencyMs, ttsMs });
    if (ctrl.signal.aborted && this.current === cur) this.current = null;
  }

  // Estimated wall time when the client finishes playing the current whisper.
  playbackEndsAt(cur) {
    if (cur.firstChunkAt === null) return 0;
    return cur.firstChunkAt + (cur.bytes / MP3_BYTES_PER_SEC) * 1000 + PLAYBACK_SLACK_MS;
  }

  // Cancel the current suggestion. If its whisper has started and may still be playing (audio
  // still streaming, or within its estimated playback time), tell the client with audio_stop.
  // If nothing was sent yet (still in Groq / before audio_start), cancel silently.
  cancelCurrent() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const playing = cur.audioStarted && !cur.stopped && (!cur.audioEnded || Date.now() < this.playbackEndsAt(cur));
    if (playing) {
      cur.stopped = true; // set before anything else so the TTS loop sends no further chunks
      this.send({ type: 'audio_stop' });
    }
    cur.ctrl.abort();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.warmTimer);
    if (this.current) this.current.ctrl.abort();
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

server.listen(PORT, () => console.log(`[reframe] listening on http://localhost:${PORT} (ws: /live)`));
