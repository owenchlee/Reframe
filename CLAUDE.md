# Reframe — shared context (backend + frontend devs and their agents)

Hackathon project. Theme: "help you larp someone you're not."
Reframe is a **live conversation coach for shy people**. The laptop mic listens to a
conversation, the backend transcribes it live, scores how engaged the other person is,
and whispers ONE short line (a question or reply, max 15 words) into the user's earbuds.
The user larps a more confident version of themselves. The agent is a coach, not a
script: it reads the other person's signals and tells the user to wrap up gracefully
when they're not interested.

## Product rules
- Respect the other person's signals. When engagement is `cold`, suggest a polite exit
  line, never a push-on line.
- Privacy: audio is processed live and never written to disk. Never log transcripts or audio.
- No features for deceiving a real interviewer, no covert recording of strangers, no storing audio.
- Demo is a roleplay with a friend who knows it's a demo.

## Stack
- `backend/`: Node + Express (CommonJS), `ws` (WebSocket), dotenv. Port 3001. (multer removed.)
  Files: `server.js`, `deepgram.js` (STT), `signalEngine.js`, `suggest.js` (Groq), `tts.js`,
  `httpClient.js` (keep-alive pool), `test-client.js`, `make-test-clip.js`, `bench.js` (latency),
  `test/` (engine tests: `npm run test:engine`).
  Also `speakerLabeler.js` (me/them labeling), `npm run test:labeler`, `npm run scenario:diarization`.
- `frontend/`: React (owned by the frontend dev; tooling TBD, document here once chosen).
  On `audio_stop` the client must stop playback immediately and drop any queued mp3 chunks.
  When the user presses Start, run a calibration step (`calibrate` start, user talks alone for
  ~5-10s, `calibrate` stop, show the `calibrated` result). The space bar becomes an optional override.
- Live transcription: Deepgram Nova-3 live streaming speech-to-text.
- Suggestion LLM: Groq (OpenAI-compatible chat completions, fast small instruct model).
- Voice out: ElevenLabs TTS, lowest-latency model, streamed mp3.
- Browser audio: input is the **laptop mic** via `getUserMedia` (Bluetooth earbud mics drop
  to call quality and add lag); output goes to the earbuds via `setSinkId` on the audio element.

## WebSocket protocol — `ws://localhost:3001/live` (source of truth)
Client → server:
- Binary frames: 16kHz mono PCM audio.
- `{type:"speaker", who:"me"|"them"}`: sent on talk-key press/release (hold space = `me`; default `them`).
- `{type:"calibrate", action:"start"|"stop"}`: while calibrating the user talks alone; their voice's
  diarization label becomes `me`. Speaker messages still override diarization while held.

Server → client:
- `{type:"transcript", who:"me"|"them", text, final}`
- `{type:"engagement", state:"engaged"|"neutral"|"cold", talkRatio, reasons:[...]}`
- `{type:"suggestion", text, mode:"ask"|"reply"|"exit", latencyMs}`
- `{type:"audio_start"}`, then binary mp3 chunks, then `{type:"audio_end"}`
- `{type:"timing", latencyMs, ttsMs}`
- `{type:"audio_stop"}`: the whisper being played is stale (they resumed talking, or the user
  pressed the talk key). Stop playback now, discard its queued chunks. Terminal for that suggestion:
  no further audio_end/timing. May also arrive after audio_end while the whisper is still playing.
- `{type:"calibrated", ok:boolean, reason?:string}`: reply to calibrate stop. `ok:false` if no/too little
  speech or more than one voice. Uncalibrated sessions label everything `them` unless space is held.

Latency target: end of the other person's turn → suggestion text ready in **under 1.5s**. The UI shows
the measured latency on screen. Keep this section updated whenever a message shape changes.

## Signal engine (backend module, plain JS, no LLM)
- Per turn: speaker, word count, start/end time, whether it contained a question,
  laughter tags (if the STT provides them), response delay after the user's turn.
- Derived: `talkRatio`, the other person's average reply length over the last 3 turns, engagement state.
  - `cold`: 2+ consecutive short replies (under 5 words), no questions back, slow responses.
  - `engaged`: long replies, the other person asks questions or laughs.
  - `neutral`: otherwise.
- Thresholds live in constants at the top of the module.
- The engine decides the mode (`ask` / `reply` / `exit`). the LLM only writes the line.

## Parked (do not build yet)
Story bank (user-typed facts for personalized lines), practice mode with simulated people,
post-conversation debrief, speaker diarization (push-to-talk is used instead).
Update 2026-11-01: diarization + calibration is now built (Stage A); push-to-talk stays as override.

## Demo plan
Live or recorded roleplay with a friend. Show the engagement meter changing, the one-line
suggestion, the latency number, and the exit line when the friend plays someone uninterested.

## Ownership rules
- Backend dev edits only `backend/`. Frontend dev edits only `frontend/`.
- Changes to this file or the WebSocket protocol need both devs to agree.
- Never commit `.env` or `node_modules` (both are in `.gitignore`).
- Secrets live in `backend/.env`. Variable names only: `DEEPGRAM_API_KEY` (STT),
  `ELEVENLABS_API_KEY` (TTS only), `GROQ_API_KEY` (suggestions), `PICOVOICE_ACCESS_KEY` (optional,
  voiceprint; not set, so voiceprint is off).
- Before pushing: `git pull --rebase origin main`. Small, frequent commits.

## How to run
- Backend: `cd backend && npm install && node server.js` (optional `ELEVENLABS_VOICE_ID` in `.env`)
- Test without frontend: `node test-client.js <audio-file> [--me 4-7.5,12-15] [--play]`
- Frontend: TBD once set up.

## Status
Backend verified end to end with real keys. `node bench.js 8` on `test-clip.mp3` (2026-11-01):
latencyMs p50 965 / worst 1679, ttsMs p50 193 / worst 1146 (15 of 16 turns within both targets).
`frontend/` is empty.

- [x] WebSocket server (`/live` on port 3001)
- [x] Deepgram Nova-3 live streaming
- [x] Signal engine
- [x] Groq suggestions
- [x] TTS streaming
- [x] Test client
- [x] Protocol change (2026-11-01): added `audio_stop` (server -> client); frontend must handle it
- [x] Protocol change (2026-11-01): added `calibrate` (client -> server) and `calibrated` (server -> client)
- [x] Speaker diarization + calibration (Stage A): 100% word labels on test-clip.mp3, 3 runs, no latency cost
- [ ] Voiceprint (Stage B, Picovoice Eagle): not built, PICOVOICE_ACCESS_KEY not set
- [ ] Frontend mic capture (laptop mic, 16kHz PCM)
- [ ] Frontend earbud playback (`setSinkId`)
- [ ] UI: engagement meter + latency number
