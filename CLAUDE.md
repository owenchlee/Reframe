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
  Also `lines.js` (hand-written coach lines per persona: ask.engaged/neutral, reply.asked/engaged/neutral)
  and `lineBank.js` (per-socket shuffled pools, `npm run test:lines`). `npm run test:invented` (invented-fact guard).
  Also `profile.js` + `profile.example.txt` (committed example) and `profile.local.txt` (gitignored, the
  real default "about me" profile; falls back to the example if missing). `npm run test:profile`;
  `npm run sample:profile` (live Groq sample, max 8 calls, stops at the first 429).
  Also `voice.js` (voice matching with sherpa-onnx speaker embeddings, model in `backend/models/`, gitignored)
  and `test/enroll.js` (generated calibration clip in the "me" voice, in memory, for scenarios and bench).
  Speaker labeling (2026-11-01), strongest first: push-to-talk; voice match per segment (the user's voice
  is enrolled at calibration: spoken parts cut by Deepgram word times, ~3s windows, averaged embedding);
  diarization. Segments of at least `MIN_SEGMENT_SECONDS` (1.0, speakerLabeler.js) get a vote: cosine
  similarity above `ME_HIGH` (0.5) = me, below `THEM_LOW` (0.4) = them, in between = diarization. If
  diarization collapsed to one label (second label < 10% of the last 60 words), in-between and no-vote
  segments are them, unless the user's own turn continues after < 700ms. Labels change only at segment
  boundaries. Voice uses the last 3s of a segment (`MAX_SCORE_SECONDS`, voice.js), 2 ONNX threads.
  Rolling 30s PCM buffer, enrollment audio and embedding are per socket, in memory, dropped on close.
  `DEBUG_LABELS` (server.js, default true) logs one numbers-only line per segment:
  `[labels] seg N at Ts words W dur Ds diar {label:count} [collapsed] sim S -> me|them (voice|diar|collapsed|continuity|ptt) embed Mms`.
- `frontend/`: React (owned by the frontend dev; tooling TBD, document here once chosen).
  On `audio_stop` the client must stop playback immediately and drop any queued mp3 chunks.
  When the user presses Start, run a calibration step (`calibrate` start, user talks alone for
  ~5-10s, `calibrate` stop, show the `calibrated` result). The space bar becomes an optional override.
  Suggestions now arrive only when delivered (stuck detector). Handle `suggestion_dropped` (e.g. show
  "you handled it"). Send `{type:"persona"}` from the Start screen. Optional "help" button sends `{type:"help"}`.
- Live transcription: Deepgram Nova-3 live streaming speech-to-text.
- Suggestion LLM: Groq (OpenAI-compatible chat completions, fast small instruct model).
  Line policy (2026-11-01): bank first, each line once per conversation, then the LLM. `ask` uses
  ask.engaged/neutral by engagement; `reply` uses reply.asked if their last turn had a question, else
  reply.engaged/neutral; `exit` always goes to the LLM. A bank hit skips Groq. Pools are shuffled per
  session, in memory only; each persona has its own state. `BANK_FIRST_FOR_REPLIES` (lineBank.js) =
  false sends every reply to the LLM. The LLM prompt (suggest.js, temperature 0.8) gets the persona
  brief, mode, engagement + reasons, whether they asked, last 6 turns and the last 12 delivered lines
  (do not repeat); one retry if the answer's first two words match, or >60% of its words overlap, one
  of the last 6 lines.
  Profile + flow (2026-11-01): the session profile (trimmed, max 2000 chars, default = profile.local.txt)
  is appended to the system prompt as "ABOUT THE USER (the only facts you may state about the user)".
  Questions about the user are answered from it in first person (one detail, then a hook back on the same
  topic); nothing in the profile -> invent nothing, react and hand the question back. Flow first: stay on
  the thread they opened; pivot only when it is exhausted, after two short answers, or on exit. The
  per-turn message carries `Turns so far` and `Flow phase: true/false` (true while turns <= `FLOW_TURNS`
  = 6, suggest.js). `BANK_ASK_AFTER_TURNS` = 8 (lineBank.js): before 8 turns, `ask` skips the bank and
  the LLM asks a follow-up on the current thread. Profile text is never logged.
  Invented-fact guard (suggest.js): every LLM line is checked against first-person fact patterns ("I work",
  "my job", "same here", "not yet", subject-dropped "Still working..."; allowed reactions like "I love",
  "I'm curious" are exempt; lists are constants at the top). Rejected -> one retry with a note; rejected
  again -> the turn is skipped like a Groq failure (status-only log). Bank lines are not checked.
  With a non-empty profile, a first-person claim passes if it shares a distinctive content word (3+
  letters, not in `STOPWORDS`, which also lists generic profile words like love/favorite/friends) with the
  profile ("Levi, no contest" passes, "I work at Google" does not). Empty profile = the old behavior.
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
- `{type:"profile", text:string}` (added 2026-11-01): replaces this session's "about me" profile (trimmed,
  capped at 2000 chars; non-strings ignored, no reply). Never sent = the server default. Memory only.
- HTTP `GET /api/profile-default` -> `{text}`: the server's default profile, for the client to prefill.

Server → client:
- `{type:"transcript", who:"me"|"them", text, final}`
- `{type:"engagement", state:"engaged"|"neutral"|"cold", talkRatio, reasons:[...]}`
- `{type:"suggestion", text, mode:"ask"|"reply"|"exit", latencyMs}`
  Stuck detector: sent only when a line is actually delivered (right before its audio_start). latencyMs
  is unchanged: their last word end -> text ready (not including any hold).
  Also carries `source:"bank"|"llm"` (added 2026-11-01): hand-written bank line or Groq.
- `{type:"audio_start"}`, then binary mp3 chunks, then `{type:"audio_end"}`
- `{type:"timing", latencyMs, ttsMs}`
  Also carries `heldMs`: how long the ready line was held before release (0 when not held). ttsMs is
  text ready -> first mp3 chunk received from TTS.
- `{type:"audio_stop"}`: the whisper being played is stale (they resumed talking, or the user
  pressed the talk key). Stop playback now, discard its queued chunks. Terminal for that suggestion:
  no further audio_end/timing. May also arrive after audio_end while the whisper is still playing.
- `{type:"calibrated", ok:boolean, reason?:string}`: reply to calibrate stop. `ok:false` if no/too little
  speech or more than one voice. Uncalibrated sessions label everything `them` unless space is held.
  Added 2026-11-01 (voice matching on): reason `"Keep talking a little longer"` when there is less than
  `MIN_ENROLL_SECONDS` (4s) of speech; the audio is kept and the next calibrate start/stop continues from it.
- `{type:"suggestion_dropped", mode}`: a held line was discarded because someone started speaking
  during the hold (or the talk key was pressed, or a newer turn replaced it). No audio follows.
- `{type:"persona_set", id}`: reply to `persona`, with the persona now in effect.
- `{type:"profile_set", ok:true, chars}` (added 2026-11-01): reply to `profile`, with the stored length.

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
  unused: voice matching uses sherpa-onnx locally, no key).
- Before pushing: `git pull --rebase origin main`. Small, frequent commits.
- Update 2026-11-01: one dev now owns both `backend/` and `frontend/` (the frontend dev is away).
  Keep the protocol section in sync with both folders when anything changes.

## How to run
- Backend: `cd backend && npm install && node server.js` (optional `ELEVENLABS_VOICE_ID` in `.env`)
  Voice matching model (once, ~28MB, not committed): `mkdir -p backend/models && curl -L -o
  backend/models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`
  (sha256 in the release's checksum.txt). Missing model: one log line, diarization-only labeling.
  `sherpa-onnx-node` is pinned to 1.13.8. Linux: if the native addon fails to load, start with `npm start`,
  which sets `LD_LIBRARY_PATH` to `node_modules/sherpa-onnx-linux-x64` (plain `node server.js` loaded
  fine on the dev laptop; if it can't load, voice matching is off with one log line).
- Test without frontend: `node test-client.js <audio-file> [--me 4-7.5,12-15] [--play]`
- Optional env (not secrets): `REFRAME_STUCK_MS` (hold before whispering, default 1500; 0 = play at once,
  use 0 for bench.js and the older scenarios), `PORT` (default 3001), `REFRAME_VOICE=off` (diarization
  only), `REFRAME_FORCE_SPEAKER=0` (test only: every diarization label forced to 0, simulates collapse).
  `node bench.js N --enroll` calibrates each session first (voice matching active).
  `scenario:diarization -- 3 --url ... [--label name] [--forced]` (with `--forced`, run the server with
  `REFRAME_FORCE_SPEAKER=0`; passes if Sarah's turns stay `them`).
- Frontend: TBD once set up.
- Frontend (2026-11-01): React + Vite. `cd frontend && npm install && npm run dev` -> https://localhost:5173
  (self-signed cert; `/live` is proxied to `ws://localhost:3001`). `npm run build` for a production build.
  No keys? `cd frontend && npm run mock` serves a scripted `/live` + `GET /api/profile-default` on port
  3001 (stop the backend first, or `PORT=3003 npm run mock` and `BACKEND_URL=http://localhost:3003 npm run dev`).
  The dev server proxies `/live` (ws) and `/api` (http) to `BACKEND_URL` (default http://localhost:3001).
  `VITE_WS_URL` points the page at another backend; `NO_SSL=1` serves plain http.
- Frontend flow (2026-11-01, hands-free): home = report + persona picker + collapsed Audio settings +
  Start. One tap on Start connects and calibrates automatically (~8s, retry on failure), then the live
  screen: pinned header (timer, persona, End), large coach line with mode chip, compact engagement
  row, transcript as the only scroll region, timings footer only in Demo view. No on-screen talk or
  help buttons; holding space still sends `speaker` as an undocumented shortcut. `help` is not sent
  from the UI anymore (the protocol message still exists). Layout checked at 390x844, 1366x768,
  1920x1080: no page scroll, nothing clipped.
- Frontend on a phone (2026-11-01, phone-first; laptop still works): run `npm run dev` on the laptop,
  open the printed **Network** URL (https, accept the cert) in the phone's browser on the same Wi-Fi.
  The page connects to its own origin's `/live` (dev proxy -> backend), never a hardcoded localhost.
  Optional: Share -> Add to Home Screen (manifest + apple meta tags, full screen; no service worker).
  Start screen: persona, **Test whisper** (in-memory tone, checks sound reaches the earbuds), mic tip,
  Audio settings (input list only once device labels exist; no "Whisper to" on phones, the OS routes
  to Bluetooth). The Start tap unlocks audio (AudioContext + audio element) and takes a Screen Wake Lock
  (re-acquired on visibilitychange; muted canvas-video fallback). If the browser stops the mic while
  hidden: "Coaching paused, tap to resume". If the socket drops: "Connection lost, tap to resume"
  (reconnects + recalibrates; the summary keeps running). Haptic pulse per delivered line (`HAPTICS`).
- Pocket mode (live screen button): near-black overlay with a dim timer and an unlock ring; every
  touch and key is ignored (content behind is `inert`) except a ~1.5s press-and-hold on the ring.
  Socket, mic and whispers keep running; End is unreachable while locked.
- Frontend tests: `cd frontend && npm test` (16kHz resampler math on the real worklet at 48k/44.1k/16k).
- About you (2026-11-01, Start screen, between persona and Audio settings): collapsible notes the coach
  answers questions about the user from (max 2000 chars). Prefilled from `GET /api/profile-default`
  (relative URL via the proxy); the user's edits are kept in localStorage on this device only
  (`reframe.profile.v1`), "Reset to default" restores the fetched text. Sent as `{type:"profile", text}`
  once right after the socket opens (before calibration) and again if it changes mid-conversation;
  `profile_set` shows a small "Saved". Privacy line: "Conversations aren't saved: no audio or words.
  Your About you notes stay on this device."
- Start screen = landing page (2026-11-01, no new routes): headline "Larp a more confident you.", a
  one-sentence subline and three steps (stacked on phones, one wrapping row on wider screens) above the
  report and setup. On short screens (<=700px tall, e.g. 360x640) the Start button is fixed at the
  bottom over a fade so it is visible without scrolling; taller screens keep the pinned setup panel.

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
- [x] Voice matching (2026-11-01, sherpa-onnx, 3D-Speaker CAM++ zh_en): test-clip.mp3 + generated
  enrollment, 3 runs each: diar-only 100%; voice+diar 100% (George 0.75-0.82, Sarah 0.11-0.18); forced
  single diarization label: diar-only 43% (all Sarah words "me", the phone bug), voice+diar 100%.
  bench 5-6 runs --enroll, stuck 0: latencyMs p50 1092 (voice off) vs 1165 (voice on), embed 74-131ms
  per segment in the server. Not yet tested with real human voices on a phone mic: tune ME_HIGH/THEM_LOW
  from the [labels] lines.
- [x] Profile + flow (2026-11-01): test:profile 9/9, test:invented 46/46, test:lines 24/24, engine,
  labeler pass. Live sample: "What's your favorite character in Attack on Titan?" -> "Levi, no contest.
  The way he moves is insane. Who's yours?" (from the profile); the other 5 questions not run.
- [ ] BLOCKED: Groq daily token limit (200k tokens/day, on_demand tier) used up by testing on 2026-11-01.
  scenario:audio-stop / scenario:stuck and the rest of sample:profile fail with HTTP 429 until it
  recovers (rolling 24h). Each request is ~1.1-1.5k tokens (prompt + profile), hedges can double it:
  ~150 suggestions/day. Demo day needs Groq Dev Tier or a smaller prompt / less hedging.
- [x] Protocol change (2026-11-01): added `help`, `persona` (client -> server), `suggestion_dropped`,
  `persona_set` (server -> client), `heldMs` in timing; `suggestion` only on delivery
- [x] Stuck detector (hold 1500ms, release / drop / help) and personas: `npm run scenario:stuck` passes
- [x] Line bank (2026-11-01): `source` on suggestion; `npm run test:lines` 23/23. `bench.js 5`,
  REFRAME_STUCK_MS=0: bank turns latencyMs p50 581 / worst 2353 (Groq skipped, all end-of-turn detection),
  LLM turns p50 1231 / worst 1673 (llm stage p50 558). Engine, labeler, audio-stop, diarization, stuck pass.
- [x] Invented-fact guard + new persona briefs (2026-11-01): `npm run test:invented` 37/37. Live sample
  (asked-question inputs, 4 personas, 6 Groq calls): 2 lines rejected, 1 turn skipped, 4 delivered.
- [x] Frontend (2026-11-01): calibration step, persona picker, input/output device pickers with an
  earbud-mic warning, hold-space shortcut, live transcript (interim/final),
  engagement, delivered suggestion, timing (latency/tts/held), audio_start/end/stop, suggestion_dropped,
  1011/close handling with restart without reload. Verified against the mock in headless Chrome.
- [x] Frontend mic capture (16kHz mono Int16 from 44.1/48 kHz, box-filter downsampling, tested); default input
- [ ] Frontend earbud playback (`setSinkId`): built, needs a manual test with real earbuds
- [x] Frontend hands-free live layout (2026-11-01): auto-calibration, coach line, transcript-only scroll
- [x] Frontend phone-first (2026-11-01): pocket mode, wake lock, mic-pause and connection-lost resume,
  gesture audio unlock, Test whisper, PWA icons, haptics. Verified in headless Chrome at 360x640,
  390x844, 430x932, 1366x768 against the mock
- [ ] Frontend on a real phone: iOS Safari, Bluetooth routing, real pocket mic (needs a manual test)
- [x] UI: engagement meter + latency number
