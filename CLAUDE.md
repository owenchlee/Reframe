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
  Also `personas.js` (persona style briefs), `npm run scenario:stuck` (stuck detector + personas).
- `frontend/`: React (owned by the frontend dev; tooling TBD, document here once chosen).
  On `audio_stop` the client must stop playback immediately and drop any queued mp3 chunks.
  When the user presses Start, run a calibration step (`calibrate` start, user talks alone for
  ~5-10s, `calibrate` stop, show the `calibrated` result). The space bar becomes an optional override.
  Suggestions now arrive only when delivered (stuck detector). Handle `suggestion_dropped` (e.g. show
  "you handled it"). Send `{type:"persona"}` from the Start screen. Optional "help" button sends `{type:"help"}`.
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
- `{type:"help"}`: release a held suggestion immediately (as soon as its text is ready); ignored if none is held.
- `{type:"persona", id:"founder"|"charmer"|"listener"|"funny"}`: any time, default `founder`. Unknown id
  keeps the previous persona. Style only; `exit` mode ignores the persona (polite exit always wins).

Server → client:
- `{type:"transcript", who:"me"|"them", text, final}`
- `{type:"engagement", state:"engaged"|"neutral"|"cold", talkRatio, reasons:[...]}`
- `{type:"suggestion", text, mode:"ask"|"reply"|"exit", latencyMs}`
  Stuck detector: sent only when a line is actually delivered (right before its audio_start). latencyMs
  is unchanged: their last word end -> text ready (not including any hold).
- `{type:"audio_start"}`, then binary mp3 chunks, then `{type:"audio_end"}`
- `{type:"timing", latencyMs, ttsMs}`
  Also carries `heldMs`: how long the ready line was held before release (0 when not held). ttsMs is
  text ready -> first mp3 chunk received from TTS.
- `{type:"audio_stop"}`: the whisper being played is stale (they resumed talking, or the user
  pressed the talk key). Stop playback now, discard its queued chunks. Terminal for that suggestion:
  no further audio_end/timing. May also arrive after audio_end while the whisper is still playing.
- `{type:"calibrated", ok:boolean, reason?:string}`: reply to calibrate stop. `ok:false` if no/too little
  speech or more than one voice. Uncalibrated sessions label everything `them` unless space is held.
- `{type:"suggestion_dropped", mode}`: a held line was discarded because someone started speaking
  during the hold (or the talk key was pressed, or a newer turn replaced it). No audio follows.
- `{type:"persona_set", id}`: reply to `persona`, with the persona now in effect.

Stuck detector: after the other person's turn the line is generated and its audio buffered in memory,
but only delivered if nobody starts speaking within `REFRAME_STUCK_MS` (default 1500) of their last word.

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
- Update 2026-11-01: one dev now owns both `backend/` and `frontend/` (the frontend dev is away).
  Keep the protocol section in sync with both folders when anything changes.

## How to run
- Backend: `cd backend && npm install && node server.js` (optional `ELEVENLABS_VOICE_ID` in `.env`)
- Test without frontend: `node test-client.js <audio-file> [--me 4-7.5,12-15] [--play]`
- Optional env (not secrets): `REFRAME_STUCK_MS` (hold before whispering, default 1500; 0 = play at once,
  use 0 for bench.js and the older scenarios), `PORT` (default 3001).
- Frontend: TBD once set up.
- Frontend (2026-11-01): React + Vite. `cd frontend && npm install && npm run dev` -> https://localhost:5173
  (self-signed cert; `/live` is proxied to `ws://localhost:3001`). `npm run build` for a production build.
  No keys? `cd frontend && npm run mock` serves a scripted `/live` on port 3001 (stop the backend first).
  `VITE_WS_URL` points the page at another backend; `NO_SSL=1` serves plain http.

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
- [x] Protocol change (2026-11-01): added `help`, `persona` (client -> server), `suggestion_dropped`,
  `persona_set` (server -> client), `heldMs` in timing; `suggestion` only on delivery
- [x] Stuck detector (hold 1500ms, release / drop / help) and personas: `npm run scenario:stuck` passes
- [x] Frontend (2026-11-01): calibration step, persona picker, input/output device pickers with an
  earbud-mic warning, optional talk override + hold space, help button, live transcript (interim/final),
  engagement, delivered suggestion, timing (latency/tts/held), audio_start/end/stop, suggestion_dropped,
  1011/close handling with restart without reload. Verified against the mock in headless Chrome.
- [x] Frontend mic capture (laptop mic, 16kHz PCM): input picker defaults to a built-in mic
- [ ] Frontend earbud playback (`setSinkId`): built, needs a manual test with real earbuds
- [x] UI: engagement meter + latency number
