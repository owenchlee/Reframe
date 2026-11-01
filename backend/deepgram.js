// Deepgram live streaming speech-to-text (Nova-3), one upstream socket per /live session.
// Docs: wss://api.deepgram.com/v1/listen, header "Authorization: Token <key>", raw binary audio in,
// JSON Results / UtteranceEnd out. Word start/end are seconds from the start of this stream.
// Never logs audio or transcript text.
//
// Events: 'ready', 'partial'(text, words[{start,end}]), 'committed'(text, words[{text,start,end}]),
//         'endOfTurn'(lastWordEndSec), 'upstreamError'(msg), 'warning'(msg), 'error'(err), 'close'(code)
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const SAMPLE_RATE = 16000;
// Silence (ms) before Deepgram marks speech_final. This is the main end-of-turn latency knob.
const ENDPOINTING_MS = 200;
// A final chunk with at least this much silence after its last word also ends the turn
// (Deepgram's endpointing sometimes doesn't set speech_final). Tuned on test-clip.mp3.
const TRAILING_SILENCE_END_MS = 200;
// Backup end-of-utterance signal when endpointing misses (noise). Deepgram recommends >= 1000.
const UTTERANCE_END_MS = 1000;
// Deepgram closes after 10s without audio; send KeepAlive if nothing was sent for this long.
const KEEPALIVE_MS = 4000;
// Max audio buffered (bytes) while the upstream socket is still connecting (~5s).
const MAX_PENDING_BYTES = SAMPLE_RATE * 2 * 5;

class DeepgramStream extends EventEmitter {
  constructor(apiKey) {
    super();
    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: String(UTTERANCE_END_MS),
    });
    this.pending = [];
    this.pendingBytes = 0;
    this.lastSent = Date.now();
    this.turnOpen = false; // finals received since the last end-of-turn
    this.lastWordEnd = 0;
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    this.ws.on('open', () => {
      for (const buf of this.pending) this.ws.send(buf);
      this.pending = [];
      this.pendingBytes = 0;
      this.lastSent = Date.now();
      this.keepalive = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastSent >= KEEPALIVE_MS) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          this.lastSent = Date.now();
        }
      }, 1000);
      this.emit('ready');
    });
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('unexpected-response', (req, res) => {
      this.emit('error', new Error(`Deepgram HTTP ${res.statusCode}`));
      this.ws.terminate();
    });
    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', (code) => {
      clearInterval(this.keepalive);
      this.emit('close', code);
    });
  }

  _endTurn(lastWordEnd) {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.emit('endOfTurn', lastWordEnd || this.lastWordEnd);
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      const text = alt?.transcript || '';
      if (!msg.is_final) {
        if (text) this.emit('partial', text, (alt.words || []).map((w) => ({ start: w.start, end: w.end })));
        return;
      }
      if (text) {
        const words = (alt.words || []).map((w) => ({ text: w.punctuated_word || w.word, start: w.start, end: w.end }));
        if (words.length) this.lastWordEnd = words[words.length - 1].end;
        this.turnOpen = true;
        this.emit('committed', text, words);
      }
      // End of turn: Deepgram's endpointing fired (speech_final), or this final chunk already
      // contains >= TRAILING_SILENCE_END_MS of silence after the last word (endpointing sometimes misses
      // this; without it we'd wait ~1s for UtteranceEnd).
      const trailingSilenceMs = (msg.start + msg.duration - this.lastWordEnd) * 1000;
      if (msg.speech_final || (this.turnOpen && trailingSilenceMs >= TRAILING_SILENCE_END_MS)) this._endTurn(this.lastWordEnd);
    } else if (msg.type === 'UtteranceEnd') {
      // Only fires the turn end if speech_final didn't already.
      this._endTurn(msg.last_word_end);
    } else if (msg.type === 'Error' || msg.err_code) {
      this.emit('upstreamError', `${msg.err_code || 'error'}: ${msg.description || msg.err_msg || ''}`);
    } else if (msg.type === 'Warning') {
      this.emit('warning', msg.description || 'warning');
    }
  }

  write(buf) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
      this.lastSent = Date.now();
    } else if (this.ws.readyState === WebSocket.CONNECTING && this.pendingBytes < MAX_PENDING_BYTES) {
      this.pending.push(buf);
      this.pendingBytes += buf.length;
    }
  }

  close() {
    clearInterval(this.keepalive);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' })); // flushes final results, then Deepgram closes
      setTimeout(() => this.ws.terminate(), 1500);
    } else {
      this.ws.terminate();
    }
  }
}

module.exports = { DeepgramStream, SAMPLE_RATE };
