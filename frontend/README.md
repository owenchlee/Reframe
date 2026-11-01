# Reframe frontend (MVP)

React + Vite, installable on iPhone as a Home Screen web app (PWA).

The screen is a **conversation report**, not a live dashboard: the coach talks through
earbuds during a conversation, and the app shows how it went afterwards.

## Run it

```bash
cd frontend
npm install
npm run dev          # https://localhost:5173 (also prints a Network URL)
```

Then either:

- **Real backend:** in another terminal `cd backend && npm install && node server.js`.
  Needs `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` and `GROQ_API_KEY` in `backend/.env`.
- **No keys (mock):** `cd frontend && npm run mock`. It replays a scripted conversation
  on `ws://localhost:3001/live` once audio starts flowing. Stop the real backend first
  (same port).

The dev server uses a self-signed HTTPS certificate (iPhone and Chrome only allow the
mic on HTTPS). The first time, click through the browser's certificate warning.
`/live` is proxied to `localhost:3001`, so the page uses `wss://` on its own host.
Set `VITE_WS_URL` to point at a different backend.

## Use it

1. Pick a coach style (Founder, Charmer, Listener, Funny). Under **Audio**, pick the laptop mic
   to listen with and your earbuds to whisper to (remembered; the app warns if the mic looks like
   the earbuds).
2. Click **Start a conversation**, allow the microphone, then talk on your own for ~8 seconds so
   the coach learns your voice. If it fails, **Try again** (or skip and use the space bar).
3. Talk normally: the backend labels who is speaking. **Mark: I'm talking** (or holding SPACE)
   is an optional override. **Help me** whispers a held line right away instead of waiting.
4. **End conversation** saves a summary to the report.

The mock (`npm run mock`) emits every message type, including calibration, held/dropped lines
and `audio_stop`. Options: `MOCK_CALIBRATE_FAIL_ONCE=1`, `MOCK_CLOSE_1011_AFTER_MS=4000`,
`MOCK_FAST=1`, `PORT`.
4. Switch on **Demo view** (top right) to show the live suggestion, engagement reading,
   latency, voice time and transcript. The setting is remembered.

## On an iPhone

Same Wi-Fi as the laptop, open the dev server's **Network** URL in Safari, accept the
certificate warning, then Share, then Add to Home Screen. Not tested on a device yet.
iOS Safari cannot pick an output device, so audio goes to whatever the phone is using.
For the demo, the laptop mic is the intended input.

## What is stored

Summaries only, in this browser's local storage: time, duration, seconds in each
engagement state, talk share, number of coach lines, whether the coach suggested wrapping
up. **No transcript text and no audio** is saved, and nothing is sent anywhere.
"Delete history" on the report screen clears it.

## Layout

- `src/App.jsx` report, live and demo screens
- `src/Ring.jsx` proportional pill ring
- `src/useLive.js` WebSocket, mic, calibration and playback wiring (protocol in `../CLAUDE.md`)
- `src/devices.js` input/output device pickers (only device ids are remembered)
- `src/sessions.js` on-device summaries
- `public/pcm-worklet.js` mic to 16kHz mono PCM
- `mock/server.js` scripted stand-in for the backend
