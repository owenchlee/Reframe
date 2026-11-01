// Test client: streams a local audio file to ws://localhost:3001/live in real time and prints events.
//
// Usage:
//   node test-client.js <audio-file> [--me 4-7.5,12-15] [--play] [--url ws://localhost:3001/live]
//
// <audio-file>  any format ffmpeg can read (converted to 16kHz mono PCM), or a raw 16kHz s16le .pcm file.
// --me          time ranges (seconds) where YOU are speaking (simulates holding space). Default: all "them".
// --play        play each whispered suggestion through ffplay as it arrives.
//
// Also usable as a module (bench.js): runSession({ pcm, me, url, log }) resolves with every
// event received, each stamped with ms since connect: [{ t, msg }] or [{ t, binary: bytes }].
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
    throw new Error(`ffmpeg failed: ${r.stderr ? r.stderr.toString() : 'is ffmpeg installed?'}`);
  }
  return r.stdout;
}

function runSession({ pcm, me = [], url = 'ws://localhost:3001/live', play = false, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const audioPcm = Buffer.concat([pcm, Buffer.alloc(TAIL_SILENCE_MS * BYTES_PER_MS)]);
    const chunkBytes = CHUNK_MS * BYTES_PER_MS;
    let t0 = performance.now();
    const now = () => performance.now() - t0;
    const stamp = () => `[${(now() / 1000).toFixed(1).padStart(5)}s]`;
    const events = [];
    const ws = new WebSocket(url);
    let audio = null; // { bytes, player }

    ws.on('open', () => {
      t0 = performance.now();
      log(`${stamp()} connected, streaming ${(audioPcm.length / (BYTES_PER_MS * 1000)).toFixed(1)}s of audio`);
      let offset = 0;
      let who = 'them';
      // Pace by elapsed time (not interval count) so audio time tracks wall time without drift.
      const tick = () => {
        while (offset < audioPcm.length && offset / BYTES_PER_MS <= now()) {
          const sec = offset / (BYTES_PER_MS * 1000);
          const want = me.some(([a, b]) => sec >= a && sec < b) ? 'me' : 'them';
          if (want !== who) {
            who = want;
            ws.send(JSON.stringify({ type: 'speaker', who }));
            log(`${stamp()} >> speaker ${who}`);
          }
          ws.send(audioPcm.subarray(offset, offset + chunkBytes), { binary: true });
          offset += chunkBytes;
        }
        if (offset >= audioPcm.length) {
          clearInterval(timer);
          log(`${stamp()} audio done, waiting ${WAIT_AFTER_MS / 1000}s for final events`);
          setTimeout(() => ws.close(), WAIT_AFTER_MS);
        }
      };
      const timer = setInterval(tick, 20);
      tick();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        events.push({ t: now(), binary: data.length });
        if (audio) {
          audio.bytes += data.length;
          if (audio.player) audio.player.stdin.write(data);
        }
        return;
      }
      const msg = JSON.parse(data.toString());
      events.push({ t: now(), msg });
      switch (msg.type) {
        case 'transcript':
          if (msg.final) log(`${stamp()} transcript [${msg.who}] ${msg.text}`);
          break;
        case 'audio_start':
          audio = { bytes: 0, player: null };
          if (play) {
            audio.player = spawn('ffplay', ['-v', 'error', '-nodisp', '-autoexit', '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'inherit'] });
            audio.player.stdin.on('error', () => {});
          }
          break;
        case 'audio_end':
          if (audio) {
            log(`${stamp()} audio      ${audio.bytes} bytes mp3`);
            if (audio.player) audio.player.stdin.end();
          }
          audio = null;
          break;
        default:
          log(`${stamp()} ${msg.type.padEnd(10)} ${JSON.stringify(msg)}`);
      }
    });

    ws.on('close', (code, reason) => {
      log(`${stamp()} closed (${code}${reason.length ? `: ${reason}` : ''})`);
      resolve(events);
    });
    ws.on('error', (err) => reject(new Error(`connection error: ${err.message} (is the backend running?)`)));
  });
}

module.exports = { runSession, loadPcm };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  runSession({ pcm: loadPcm(opts.file), me: opts.me, url: opts.url, play: opts.play, log: console.log })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
