---
target: Reframe phone UI
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/owenlee/Documents/GitHub/Reframe/frontend/src/App.jsx"
target_fingerprint: "sha256:7d71dca00609ffefcef471a6da28999841a43a14968cccd0405b31f84d91687d"
target_path: /Users/owenlee/Documents/GitHub/Reframe/frontend/src/App.jsx
timestamp: 2026-11-01T17-36-53Z
slug: frontend-src-app-jsx
---
# Critique: Reframe phone UI (frontend/src/App.jsx)

Method: dual-agent (A: design review, B: detector and browser check)
Score: 20/40 (Acceptable). Detector: 0 findings (files, rendered page, overlay); idle state only.

Priority issues
- [P0] Screen is designed for the wrong moment (live dashboard; nobody watches it live). Fix: past-tense conversation report. /impeccable shape, distill.
- [P1] Ring encodes no quantity; legend colours reuse engagement colours with different meanings. Fix: proportional ring, big centre number, legend matches arcs. /impeccable layout, colorize.
- [P1] Developer metrics (latency, TTS, target) in the main view; red slow value may read as failure. Fix: move to diagnostics, human lines. /impeccable distill, clarify.
- [P2] Suggestion card and live transcript dominate a review screen; transcript conflicts with privacy rule. Fix: in-memory moments list, transcript behind disclosure. /impeccable clarify, harden.
- [P3] Bare empty/error states; cold copy ("Cold"). Fix: real empty state, warmer names, retry. /impeccable onboard, harden.

Personas: Casey (accidental Stop, nothing persists), Jordan (unlabelled arcs, jargon, "Hold SPACE" on phone), Mira (shy user reviewing day: "Cold" and "you talk 80%" with no context).
