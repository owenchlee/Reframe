# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Existing codebase: React + Vite in `frontend/`, installed to the iPhone Home Screen as a PWA. Backend is Node + Express + `ws` in `backend/`.

## Users
Shy people who want to come across as a more confident version of themselves in live conversations. During a conversation the phone is in a pocket and the coach speaks to them through earbuds. The screen is for between conversations or at the end of the day, when they review how each conversation went.

## Product Purpose
Reframe is a live conversation coach. A mic listens, the backend transcribes the other person live, scores how engaged they are, and whispers one short line (max 15 words) into the user's earbuds. It acts as a coach, not a script: it reads the other person's signals and tells the user to wrap up gracefully when the other person is not interested. Success is the user having better conversations, and being able to see afterwards how they went.

## Positioning
Audio-first coaching that respects the other person's signals. When engagement is cold it suggests a polite exit, never a push-on line.

## Operating Context
Hackathon project; the demo is a roleplay with a friend who knows it is a demo. During use the screen is not watched. It is reviewed between conversations or after the day is done (confirmed by the user).

## Capabilities and Constraints
- Engagement states: `engaged`, `neutral`, `cold`. Suggestion modes: `ask`, `reply`, `exit`.
- Live data available per session: transcript lines, engagement state, talk ratio, engagement reasons, suggestion text and mode, latency and TTS timing.
- Privacy: audio is processed live and never written to disk. Transcripts and audio are never logged. No features for deceiving a real interviewer or covertly recording strangers.
- iPhone Safari has no `setSinkId`; audio follows the system output. HTTPS is required for the mic.
- UNDECIDED: a conversation "report" or history view. `CLAUDE.md` lists the post-conversation debrief as parked, and nothing is persisted today. Any report would have to respect the privacy rule (no stored transcripts or audio) and needs both devs to agree.

## Brand Commitments
Name: Reframe. No logo or voice guidelines exist beyond the product rules above.

## Evidence on Hand
No real conversation data, users or testimonials exist yet. Current numbers come from a mock server. Do not fabricate sample reports presented as real data.

## Product Principles
- Audio is the product; the screen supports it.
- Respect the other person: never push on when engagement is cold.
- Nothing the user said or heard leaves the device or hits disk.
- Show how a conversation went, not a wall of metrics.
