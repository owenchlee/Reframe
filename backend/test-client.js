// Test client: streams a local audio file to ws://localhost:3001/live in real time and prints events.
//
// Usage:
//   node test-client.js <audio-file> [--me 4-7.5,12-15] [--play] [--url ws://localhost:3001/live]
//
// <audio-file>  any format ffmpeg can read (converted to 16kHz mono PCM), or a raw 16kHz s16le .pcm file.
// --me          time ranges (seconds) where YOU are speaking (simulates holding space). Default: all "them".
// --play        play each whispered suggestion through ffplay as it arrives.
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const CHUNK_MS = 100;
const BYTES_PER_MS = 32; // 16kHz * 2 bytes / 1000
const TAIL_SILENCE_MS = 2000; // lets the STT endpointing close the final turn
const WAIT_AFTER_MS = 8000; // time to wait for the last suggestion + TTS before exiting

function parseArgs(argv) {
  const opts = { file: null, me: [], play: false, url: 'ws://localhost:3001/live' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--me') {
      opts.me = argv[++i].split(',').map((r) => r.split('-').map(Number));
    } else if (a === '--play') opts.play = true;
    else if (a === '--url') opts.url = argv[++i];
    else opts.file = a;
  }
  if (!opts.file) {
    console.error('usage: node test-client.js <audio-file> [--me 4-7.5,12-15] [--play] [--url ws://...]');
    process.exit(1);
  }
  return opts;
}

function loadPcm(file) {
  if (file.endsWith('.pcm')) return fs.readFileSync(file);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], {
    maxBuffer: 1024 * 1024 * 500,
  });
  if (r.status !== 0) {
    console.error(`ffmpeg failed: ${r.stderr ? r.stderr.toString() : 'is ffmpeg installed?'}`);
    process.exit(1);
  }
  return r.stdout;
}

const opts = parseArgs(process.argv.slice(2));
const pcm = Buffer.concat([loadPcm(opts.file), Buffer.alloc(TAIL_SILENCE_MS * BYTES_PER_MS)]);
const chunkBytes = CHUNK_MS * BYTES_PER_MS;
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;

const ws = new WebSocket(opts.url);
let audio = null; // { bytes, player }

ws.on('open', () => {
  console.log(`${stamp()} connected, streaming ${(pcm.length / (BYTES_PER_MS * 1000)).toFixed(1)}s of audio`);
  let offset = 0;
  let who = 'them';
  const timer = setInterval(() => {
    const sec = offset / (BYTES_PER_MS * 1000);
    const want = opts.me.some(([a, b]) => sec >= a && sec < b) ? 'me' : 'them';
    if (want !== who) {
      who = want;
      ws.send(JSON.stringify({ type: 'speaker', who }));
      console.log(`${stamp()} >> speaker ${who}`);
    }
    if (offset >= pcm.length) {
      clearInterval(timer);
      console.log(`${stamp()} audio done, waiting ${WAIT_AFTER_MS / 1000}s for final events`);
      setTimeout(() => ws.close(), WAIT_AFTER_MS);
      return;
    }
    ws.send(pcm.subarray(offset, offset + chunkBytes), { binary: true });
    offset += chunkBytes;
  }, CHUNK_MS);
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (audio) {
      audio.bytes += data.length;
      if (audio.player) audio.player.stdin.write(data);
    }
    return;
  }
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case 'transcript':
      if (msg.final) console.log(`${stamp()} transcript [${msg.who}] ${msg.text}`);
      break;
    case 'audio_start':
      audio = { bytes: 0, player: null };
      if (opts.play) {
        audio.player = spawn('ffplay', ['-v', 'error', '-nodisp', '-autoexit', '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'inherit'] });
        audio.player.stdin.on('error', () => {});
      }
      break;
    case 'audio_end':
      if (audio) {
        console.log(`${stamp()} audio      ${audio.bytes} bytes mp3`);
        if (audio.player) audio.player.stdin.end();
      }
      audio = null;
      break;
    default:
      console.log(`${stamp()} ${msg.type.padEnd(10)} ${JSON.stringify(msg)}`);
  }
});

ws.on('close', (code, reason) => {
  console.log(`${stamp()} closed (${code}${reason.length ? `: ${reason}` : ''})`);
  process.exit(0);
});
ws.on('error', (err) => {
  console.error(`connection error: ${err.message} (is the backend running?)`);
  process.exit(1);
});
