// ElevenLabs Scribe realtime speech-to-text client (one upstream socket per /live session).
// Docs: wss://api.elevenlabs.io/v1/speech-to-text/realtime, auth via xi-api-key header,
// audio sent as JSON {message_type:"input_audio_chunk", audio_base_64, commit, sample_rate}.
// Never logs audio or transcript text.
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const SAMPLE_RATE = 16000;
// Silence (s) before Scribe's VAD commits a segment. This is part of the turn-end latency.
const VAD_SILENCE_SECS = 0.6;
// Max audio buffered (bytes) while the upstream socket is still connecting (~5s).
const MAX_PENDING_BYTES = SAMPLE_RATE * 2 * 5;
// If a plain committed_transcript arrives, wait this long for the timestamped version.
const TIMESTAMP_GRACE_MS = 200;

class ScribeStream extends EventEmitter {
  constructor(apiKey) {
    super();
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: String(VAD_SILENCE_SECS),
      include_timestamps: 'true',
    });
    this.pending = [];
    this.pendingBytes = 0;
    this.plainTimer = null;
    this.ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, {
      headers: { 'xi-api-key': apiKey },
    });
    this.ws.on('open', () => {
      for (const buf of this.pending) this._send(buf, false);
      this.pending = [];
      this.pendingBytes = 0;
    });
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', (code) => this.emit('close', code));
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.message_type) {
      case 'session_started':
        this.emit('ready');
        break;
      case 'partial_transcript':
        if (msg.text) this.emit('partial', msg.text);
        break;
      case 'committed_transcript_with_timestamps':
        clearTimeout(this.plainTimer);
        this.plainTimer = null;
        if (msg.text) this.emit('committed', msg.text, (msg.words || []).filter((w) => w.type === 'word'));
        break;
      case 'committed_transcript':
        // Normally followed by the timestamped variant; fall back to it only if that never comes.
        if (!msg.text) break;
        clearTimeout(this.plainTimer);
        this.plainTimer = setTimeout(() => this.emit('committed', msg.text, null), TIMESTAMP_GRACE_MS);
        break;
      default:
        if (msg.error || msg.warning) {
          // Error strings come from ElevenLabs and contain no transcript content.
          this.emit(msg.error ? 'upstreamError' : 'warning', `${msg.message_type}: ${msg.error || msg.warning}`);
        }
    }
  }

  _send(buf, commit) {
    this.ws.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: buf.toString('base64'),
      commit,
      sample_rate: SAMPLE_RATE,
    }));
  }

  write(buf) {
    if (this.ws.readyState === WebSocket.OPEN) return this._send(buf, false);
    if (this.ws.readyState === WebSocket.CONNECTING && this.pendingBytes < MAX_PENDING_BYTES) {
      this.pending.push(buf);
      this.pendingBytes += buf.length;
    }
  }

  close() {
    clearTimeout(this.plainTimer);
    if (this.ws.readyState === WebSocket.OPEN) {
      this._send(Buffer.alloc(0), true); // flush the last segment
      setTimeout(() => this.ws.close(), 1500);
    } else {
      this.ws.terminate();
    }
  }
}

module.exports = { ScribeStream, SAMPLE_RATE };
