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

1. Pick a coach style (Founder, Charmer, Listener, Funny). **Audio settings** (collapsed) picks the
   laptop mic to listen with and your earbuds to whisper to; the choice is remembered, and a
   warning appears only if the mic looks like the earbuds.
2. Tap **Start a conversation** once and allow the microphone. Calibration starts by itself:
   say a few sentences about your day (~8 s). If it fails, the reason is shown with **Try again**.
3. Then just talk. It is hands-free: the backend labels who is speaking and the coach whispers a
   line only if you get stuck. The live screen shows the coach line large, a small engagement
   reading and the transcript (the only part that scrolls). **End** is the only control.
4. **Demo view** (home screen switch, remembered) adds latency, voice and held timings in a small
   footer on the live screen.

The mock (`npm run mock`) emits every message type, including calibration, held/dropped lines
and `audio_stop`. Options: `MOCK_CALIBRATE_FAIL_ONCE=1`, `MOCK_CLOSE_1011_AFTER_MS=4000`,
`MOCK_FAST=1`, `PORT`.

## On a phone (the main way to use it)

1. On the laptop: `npm run dev` (and the backend). On the phone, same Wi-Fi: open the dev server's
   **Network** URL, accept the certificate warning. Optional: Share -> Add to Home Screen to open
   it full screen.
2. Plug in earbuds, tap **Test whisper** to check the sound reaches them (the phone routes audio to
   connected earbuds; there is no output picker on phones).
3. Tap **Start a conversation**, say a few sentences, then tap **Pocket mode** and pocket the phone.
   Pocket mode ignores every touch; press and hold the ring for ~1.5 s to unlock. The screen stays
   awake (Wake Lock) and the mic keeps running.
4. If the phone stopped the mic or the connection dropped, the app says so: tap to resume.

Tip: the phone mic hears you best, the earbud mic hears them best, try both. Not yet tested on a
real phone or on iOS Safari.

## About you

The Start screen's **About you** box is what the coach uses to answer questions about you. It is
prefilled from `GET /api/profile-default`; your edits stay in this browser only, and **Reset to
default** brings the original back. It is sent to the backend as `{type:"profile", text}` when a
conversation starts.

## What is stored

In this browser's local storage only: conversation summaries (time, duration, seconds in each
engagement state, talk share, number of coach lines, whether the coach suggested wrapping up),
your **About you** notes if you edited them, and your chosen audio devices and Demo view setting.
**No transcript text and no audio** is ever saved. "Delete history" clears the summaries.

## Layout

- `src/App.jsx` home (report + setup) and live screens (calibration, coach line, transcript)
- `src/Ring.jsx` proportional pill ring
- `src/useLive.js` WebSocket, mic, calibration and playback wiring (protocol in `../CLAUDE.md`)
- `src/devices.js` input/output device pickers (only device ids are remembered)
- `src/wakeLock.js` Screen Wake Lock with a muted-video fallback
- `src/profile.js` About you: default fetch + this-device storage
- `test/resampler.test.mjs` 16 kHz resampler checks (`npm test`)
- `src/sessions.js` on-device summaries
- `public/pcm-worklet.js` mic to 16kHz mono PCM
- `mock/server.js` scripted stand-in for the backend
