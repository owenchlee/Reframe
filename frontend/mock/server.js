// Mock of the backend /live WebSocket (protocol in ../../CLAUDE.md).
// Also serves GET /api/profile-default and answers {type:"profile"} with profile_set.
// Emits every server -> client message type: calibrated, persona_set, transcript (interim + final),
// engagement, suggestion, audio_start + mp3 chunks + audio_end, timing (with heldMs), audio_stop,
// suggestion_dropped. Incoming audio frames are only counted, never kept.
//
// Env: PORT (default 3001), MOCK_CALIBRATE_FAIL_ONCE=1 (first calibration returns ok:false),
//      MOCK_FAST=1 (shorter delays, for automated walkthroughs), MOCK_PROFILE_FAIL=1 (profile-default 500),
//      MOCK_CLOSE_1011_AFTER_MS=n (close the first connection with 1011 after n ms, like an STT failure).
import http from 'http';
import { WebSocketServer } from 'ws';
import { spawnSync } from 'child_process';

const PORT = Number(process.env.PORT) || 3001;
const FAST = process.env.MOCK_FAST === '1';
// Default "About you" text (GET /api/profile-default), like the real backend. Made up.
const DEFAULT_PROFILE = `I'm Alex, I work as a product designer at a small startup.
I grew up near the coast and moved to the city three years ago.
Into climbing, film photography and trying every ramen place in town.`;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/profile-default') {
    if (process.env.MOCK_PROFILE_FAIL === '1') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: DEFAULT_PROFILE }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server, path: '/live' });
server.listen(PORT);
const PERSONAS = ['founder', 'charmer', 'listener', 'funny'];

// A short soft tone as mp3, generated in memory (stands in for the coach's whisper).
function toneMp3(seconds) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=660:duration=${seconds}`, '-af', 'volume=0.2',
    '-ac', '1', '-ar', '22050', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1 << 24 });
  if (r.status === 0 && r.stdout.length) return r.stdout;
  console.warn('ffmpeg not available: audio chunks are placeholder bytes and will not play');
  return Buffer.alloc(4000 * seconds);
}
const TONE = toneMp3(2);

const t = (who, text, final = true) => ({ type: 'transcript', who, text, final });
const eng = (state, talkRatio, reasons) => ({ type: 'engagement', state, talkRatio, reasons });

// Each step: [delayMs, action]. Actions: a message object, or a function (ws, session) => void.
function script() {
  const d = (ms) => (FAST ? Math.round(ms / 3) : ms);
  return [
    [d(1200), t('them', "Hey! I don't think", false)],
    [d(700), t('them', "Hey! I don't think we've met. I'm Sam.")],
    [d(500), eng('neutral', 0.3, ['Just getting started'])],
    // Nobody answers: the held line is released after the hold.
    [d(1500), deliver('Nice to meet you, Sam! What brings you here today?', 'ask', 980, 520)],
    [d(3500), t('me', 'Nice to meet you, Sam! What brings', false)],
    [d(600), t('me', 'Nice to meet you, Sam! What brings you here today?')],
    [d(2000), t('them', "Oh, I'm a designer, I came for the talks. Do you ever notice fonts on signs?")],
    [d(500), eng('engaged', 0.35, ['long replies', 'asked a question'])],
    // The user answers within the hold: the line is dropped, no audio.
    [d(900), t('me', 'Totally, all the time!', false)],
    [d(100), { type: 'suggestion_dropped', mode: 'reply' }],
    [d(600), t('me', 'Totally, all the time! Comic Sans on a bank, honestly.')],
    [d(2200), t('them', 'Ha, right.')],
    [d(400), eng('neutral', 0.5, ['short reply'])],
    // A line starts playing, then they resume talking: audio_stop (after audio_end).
    [d(1500), deliver('Do you work on anything fun lately?', 'ask', 1040, 0)],
    [d(700), t('them', 'Oh and actually', false)],
    [d(50), { type: 'audio_stop' }],
    [d(900), t('them', 'Oh and actually, I have to run soon.')],
    [d(500), eng('cold', 0.7, ['3 short replies in a row', 'no questions back'])],
    // A held line that waits for {type:"help"} (or releases after 3s).
    [d(200), holdForHelp('Well, great chatting, enjoy the rest of the event!', 'exit', 870)],
  ];
}

function sendLine(ws, text, mode, latencyMs, heldMs) {
  ws.send(JSON.stringify({ type: 'suggestion', text, mode, latencyMs }));
  ws.send(JSON.stringify({ type: 'audio_start' }));
  for (let i = 0; i < TONE.length; i += 1600) ws.send(TONE.subarray(i, i + 1600), { binary: true });
  ws.send(JSON.stringify({ type: 'audio_end' }));
  ws.send(JSON.stringify({ type: 'timing', latencyMs, ttsMs: 190, heldMs }));
}
function deliver(text, mode, latencyMs, heldMs) {
  return (ws) => sendLine(ws, text, mode, latencyMs, heldMs);
}
function holdForHelp(text, mode, latencyMs) {
  return (ws, session) => {
    const heldAt = Date.now();
    const release = () => {
      clearTimeout(session.helpTimer);
      session.onHelp = null;
      sendLine(ws, text, mode, latencyMs, Date.now() - heldAt);
    };
    session.onHelp = release;
    session.helpTimer = setTimeout(release, FAST ? 4000 : 3000);
  };
}

let calibrationFailures = 0;
let closedOnce = false;

wss.on('connection', (ws) => {
  console.log('client connected');
  const session = { onHelp: null, helpTimer: null };
  const closeAfter = Number(process.env.MOCK_CLOSE_1011_AFTER_MS);
  if (closeAfter && !closedOnce) {
    closedOnce = true;
    setTimeout(() => ws.readyState === ws.OPEN && ws.close(1011, 'transcription unavailable'), closeAfter);
  }
  const steps = script();
  let timer;
  let i = 0;
  let started = false;
  let calibrating = false;
  let lastCalibEvent = Date.now();
  let frames = 0;
  let persona = 'founder';

  const next = () => {
    if (i >= steps.length || ws.readyState !== ws.OPEN) return;
    const [delay, action] = steps[i++];
    timer = setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (typeof action === 'function') action(ws, session);
      else ws.send(JSON.stringify(action));
      next();
    }, delay);
  };
  const begin = () => {
    if (started) return;
    started = true;
    console.log('script started');
    next();
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) { // audio frames: counted only, never kept
      frames++;
      if (frames === 1 || frames % 100 === 0) console.log(`audio frames: ${frames} (${data.length} bytes each)`);
      // Uncalibrated (skipped) sessions start once audio flows with no calibration going on.
      if (!started && !calibrating && Date.now() - lastCalibEvent > 1500) begin();
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'speaker') console.log('speaker ->', msg.who);
    else if (msg.type === 'profile') {
      // Only the length is logged, never the text.
      const text = typeof msg.text === 'string' ? msg.text : '';
      console.log(`profile -> ${text.length} chars (${calibrating ? 'during calibration' : started ? 'during conversation' : 'before calibration'})`);
      ws.send(JSON.stringify({ type: 'profile_set', ok: text.length <= 2000, chars: text.length }));
    } else if (msg.type === 'persona') {
      if (PERSONAS.includes(msg.id)) persona = msg.id;
      console.log('persona ->', msg.id, '(in effect:', persona + ')');
      ws.send(JSON.stringify({ type: 'persona_set', id: persona }));
    } else if (msg.type === 'calibrate' && msg.action === 'start') {
      calibrating = true;
      lastCalibEvent = Date.now();
      console.log('calibrate start');
    } else if (msg.type === 'calibrate' && msg.action === 'stop') {
      calibrating = false;
      lastCalibEvent = Date.now();
      const fail = process.env.MOCK_CALIBRATE_FAIL_ONCE === '1' && calibrationFailures === 0;
      setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        if (fail) {
          calibrationFailures++;
          ws.send(JSON.stringify({ type: 'calibrated', ok: false, reason: 'more than one voice heard, calibrate alone' }));
          console.log('calibrated -> ok:false');
        } else {
          ws.send(JSON.stringify({ type: 'calibrated', ok: true }));
          console.log('calibrated -> ok:true');
          begin();
        }
      }, 400);
    } else if (msg.type === 'help') {
      console.log('help', session.onHelp ? '(releasing held line)' : '(nothing held, ignored)');
      if (session.onHelp) session.onHelp();
    }
  });
  ws.on('close', () => {
    clearTimeout(timer);
    clearTimeout(session.helpTimer);
  });
});

console.log(`mock listening on http://localhost:${PORT} (ws /live, GET /api/profile-default)`);
