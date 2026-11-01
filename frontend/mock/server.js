// Mock of the backend /live WebSocket (protocol in ../../CLAUDE.md).
// Replays a scripted conversation that ends cold -> exit. No real audio is processed or stored.
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3001;
const wss = new WebSocketServer({ port: PORT, path: '/live' });

const t = (who, text) => ({ type: 'transcript', who, text, final: true });
const eng = (state, talkRatio, reasons) => ({ type: 'engagement', state, talkRatio, reasons });
const sug = (text, mode, latencyMs) => ({ type: 'suggestion', text, mode, latencyMs });

const SCRIPT = [
  [1500, t('them', "Hey! I don't think we've met. I'm Sam.")],
  [800, eng('neutral', 0.3, ['Just getting started'])],
  [700, sug('Nice to meet you! What brings you here today?', 'ask', 980)],
  [300, { type: 'timing', latencyMs: 980, ttsMs: 310 }],
  [3500, t('me', 'Nice to meet you, Sam! What brings you here today?')],
  [2500, t('them', "Oh, I'm a designer, I came for the talks. Honestly I'm obsessed with typography, I could go on forever, do you ever notice fonts on signs?")],
  [600, eng('engaged', 0.35, ['Long reply', 'Asked you a question'])],
  [700, sug('Totally, I notice them everywhere. What font do you hate most?', 'reply', 1120)],
  [300, { type: 'timing', latencyMs: 1120, ttsMs: 290 }],
  [3500, t('me', 'Totally, I notice them everywhere.')],
  [2500, t('them', 'Cool.')],
  [500, eng('neutral', 0.5, ['Short reply'])],
  [600, sug('Do you work on anything fun lately?', 'ask', 1040)],
  [3500, t('me', 'Do you work on anything fun lately?')],
  [2500, t('them', 'Not really.')],
  [500, eng('cold', 0.7, ['2 short replies in a row', 'No questions back', 'Slow responses'])],
  [600, sug('Well, great chatting, enjoy the rest of the event!', 'exit', 1710)],
  [300, { type: 'timing', latencyMs: 1710, ttsMs: 330 }],
];

wss.on('connection', (ws) => {
  console.log('client connected');
  let timer;
  let i = 0;
  let frames = 0;
  let bytes = 0;
  const next = () => {
    if (i >= SCRIPT.length || ws.readyState !== ws.OPEN) return;
    const [delay, msg] = SCRIPT[i++];
    timer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      next();
    }, delay);
  };
  let started = false;

  ws.on('message', (data, isBinary) => {
    if (isBinary) { // audio frames: counted only, never kept
      if (!started) { started = true; next(); } // like the real backend: results only follow audio
      frames++; bytes += data.length;
      if (frames === 1 || frames % 50 === 0) console.log(`audio frames: ${frames}, last ${data.length} bytes, total ${bytes}`);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'speaker') console.log('speaker ->', msg.who);
    } catch {}
  });
  ws.on('close', () => clearTimeout(timer));
});

console.log(`mock /live listening on ws://localhost:${PORT}/live`);
