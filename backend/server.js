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
const { writeSuggestion, warmGroq } = require('./suggest');
const { streamSpeech, warmTts } = require('./tts');

const PORT = 3001;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16-bit mono PCM
const CONTEXT_TURNS = 6; // turns sent to Groq
const WARM_EVERY_MS = 1000; // check often; httpClient only warms a host after it has been idle ~4s
const WALL_LOG_SECS = 120; // how much audio-time -> wall-time mapping to keep (numbers only)

const { DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, GROQ_API_KEY, ELEVENLABS_VOICE_ID } = process.env;
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
    this.speakers = [{ at: 0, who: 'them' }]; // speaker timeline (audio seconds)
    this.wallLog = []; // [{ endSec, wall }] to convert audio time to wall-clock time
    this.inflight = null; // AbortController for the current suggestion + TTS

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
      if (this.inflight && words.some((w) => w.start > this.inflightTurnEnd && this.speakerAt(w.start) === 'them')) {
        this.cancelInflight();
      }
      this.send({ type: 'transcript', who: this.currentSpeaker(), text, final: false });
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

  currentSpeaker() {
    return this.speakers[this.speakers.length - 1].who;
  }

  speakerAt(sec) {
    let who = this.speakers[0].who;
    for (const s of this.speakers) {
      if (s.at <= sec) who = s.who;
      else break;
    }
    return who;
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
    if (msg.type === 'speaker' && (msg.who === 'me' || msg.who === 'them') && msg.who !== this.currentSpeaker()) {
      this.speakers.push({ at: this.audioSec, who: msg.who });
      if (this.speakers.length > 500) this.speakers.splice(1, 1);
    }
  }

  // Split a final STT segment by the push-to-talk timeline (word start time), then update the engine.
  onCommitted(text, words) {
    let segments;
    if (words && words.length) {
      segments = [];
      for (const w of words) {
        const who = this.speakerAt(w.start);
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
      segments = [{ who: this.speakerAt(end), text, start: end, end }];
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
    if (this.inflight) this.inflight.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;
    this.inflightTurnEnd = endSec;

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
    try {
      for await (const chunk of streamSpeech({ apiKey: ELEVENLABS_API_KEY, voiceId: ELEVENLABS_VOICE_ID, text, signal: ctrl.signal })) {
        if (ctrl.signal.aborted) break;
        if (ttsMs === null) ttsMs = Date.now() - ttsStart;
        this.sendBinary(chunk);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) console.error(`[tts] ${err.message}`);
    }
    this.send({ type: 'audio_end' });
    if (!ctrl.signal.aborted && ttsMs !== null) this.send({ type: 'timing', latencyMs, ttsMs });
    if (this.inflight === ctrl) this.inflight = null;
  }

  cancelInflight() {
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.warmTimer);
    if (this.inflight) this.inflight.abort();
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
