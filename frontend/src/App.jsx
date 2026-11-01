import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLive, PERSONAS, CALIBRATE_MS } from './useLive.js';
import {
  inputLooksLikeEarbuds, listDevices, loadDevicePref, pickOutput, saveDevicePref, showOutputPicker,
} from './devices.js';
import Ring from './Ring.jsx';
import { PROFILE_MAX, clearSavedProfile, fetchDefaultProfile, loadSavedProfile, saveProfile } from './profile.js';
import {
  STATES, avgTalkRatio, clearSessions, loadSessions, saveSessions, sumShares, takeaway, toPercents,
} from './sessions.js';

const LATENCY_TARGET_MS = 1500;
const LABEL = { engaged: 'Engaged', neutral: 'Steady', cold: 'Cooling' };
const MODE_LABEL = { ask: 'Ask', reply: 'Reply', exit: 'Wrap up' };
const DAY_MS = 86400000;

function readFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* ignore */ }
}

function fmtDuration(sec) {
  if (sec < 60) return `${Math.round(sec)} sec`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTime(ts, withDay) {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return withDay ? `${d.toLocaleDateString([], { weekday: 'short' })} ${t}` : t;
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Legend({ rows }) {
  return (
    <ul className="legend">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="dot" style={{ background: r.color }} />
          <span className="legend-label">{r.label}</span>
          <span className="legend-value">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

function stateRows(pct) {
  return STATES.map((k) => ({ label: LABEL[k], color: `var(--${k})`, value: pct ? `${pct[k]}%` : '—' }));
}

function Report({ sessions, range, setRange, onClear }) {
  const [confirm, setConfirm] = useState(false);
  const cutoff = range === 'day' ? new Date().setHours(0, 0, 0, 0) : Date.now() - 7 * DAY_MS;
  const shown = sessions.filter((s) => s.startedAt >= cutoff);
  const shares = sumShares(shown);
  const pct = toPercents(shares);
  const talk = avgTalkRatio(shown);
  const totalSec = shown.reduce((a, s) => a + s.durationSec, 0);

  return (
    <>
      <div className="seg-control" role="group" aria-label="Range">
        {[['day', 'Today'], ['week', 'Week']].map(([k, label]) => (
          <button key={k} aria-pressed={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>
            {label}
          </button>
        ))}
      </div>

      <Ring shares={pct ? shares : null} label={pct ? `${pct.engaged}% of the time they were engaged` : 'No conversations yet'}>
        {pct ? (
          <>
            <div className="hero">{pct.engaged}%</div>
            <div className="hero-sub">of the time they were engaged</div>
          </>
        ) : (
          <div className="hero-sub">No conversations yet</div>
        )}
      </Ring>

      <Legend
        rows={[
          ...stateRows(pct),
          { label: 'You talked', color: 'var(--accent)', value: talk == null ? '—' : `${Math.round(talk * 100)}%` },
          { label: 'Conversations', color: 'var(--muted)', value: String(shown.length) },
          { label: 'Time', color: 'var(--muted)', value: totalSec ? fmtDuration(totalSec) : '—' },
        ]}
      />

      <section className="list-section">
        <h2>Conversations</h2>
        {shown.length === 0 ? (
          <p className="empty">
            {range === 'day'
              ? 'Nothing yet today. Start a conversation and the coach whispers in your earbuds. How it went shows up here afterwards.'
              : 'Nothing in the last 7 days.'}
          </p>
        ) : (
          <ul className="sessions">
            {shown.map((s) => {
              const p = toPercents(s.shares);
              return (
                <li key={s.id}>
                  <div className="s-main">
                    <span className="s-time">{fmtTime(s.startedAt, range === 'week')}</span>
                    <span className="s-take">{takeaway(s)}</span>
                  </div>
                  <div className="s-side">
                    <span className="s-pct">{p ? `${p.engaged}%` : '—'}</span>
                    <span className="s-dur">{fmtDuration(s.durationSec)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {sessions.length > 0 && (
        <button
          className="text-btn"
          onClick={() => {
            if (confirm) { onClear(); setConfirm(false); } else { setConfirm(true); }
          }}
          onBlur={() => setConfirm(false)}
        >
          {confirm ? 'Tap again to delete everything' : 'Delete history from this phone'}
        </button>
      )}
    </>
  );
}

function Calibration({ live }) {
  const { calib, status } = live;
  const [, tick] = useState(0);
  useEffect(() => {
    if (status !== 'calibrating') return undefined;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [status]);
  if (status === 'calibrate_failed') {
    return (
      <section className="calib">
        <p className="calib-title">Couldn't learn your voice</p>
        <p className="calib-text">{calib.reason}</p>
        <button className="primary start calib-retry" onClick={live.calibrate}>Try again</button>
      </section>
    );
  }
  const elapsed = calib.startedAt ? Date.now() - calib.startedAt : 0;
  const pct = Math.min(100, (elapsed / CALIBRATE_MS) * 100);
  const left = Math.max(0, Math.ceil((CALIBRATE_MS - elapsed) / 1000));
  return (
    <section className="calib" aria-live="polite">
      <p className="calib-title">{calib.waiting ? 'Checking your voice…' : 'Say a few sentences about your day'}</p>
      <p className="calib-text">
        {calib.waiting ? 'One moment.' : 'Just you, talking normally, so the coach can tell your voice from theirs.'}
      </p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="calib-count">{calib.waiting ? '\u00a0' : `${left}s`}</p>
    </section>
  );
}

function PersonaPicker({ value, onChange }) {
  return (
    <div className="seg-control persona" role="group" aria-label="Coach style">
      {PERSONAS.map((p) => (
        <button key={p.id} aria-pressed={value === p.id} className={value === p.id ? 'on' : ''} onClick={() => onChange(p.id)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

// "About you": what the coach uses to answer questions about the user. Collapsed = one-line preview.
function AboutYou({ text, onChange, canReset, onReset, flash }) {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean);
  return (
    <details className="about">
      <summary>
        <span>About you</span>
        <span className="about-preview">{firstLine || 'Add a few lines about yourself'}</span>
      </summary>
      <p className="helper" id="about-help">The coach answers questions about you from this. Edit anything.</p>
      <textarea
        value={text}
        maxLength={PROFILE_MAX}
        rows={6}
        aria-describedby="about-help"
        aria-label="About you"
        placeholder="What you do, where you're from, what you're into, a story or two you like telling."
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="about-foot">
        <span className="counter">{text.length} / {PROFILE_MAX}</span>
        <span className="saved" aria-live="polite">{flash ? 'Saved' : ''}</span>
        <button type="button" className="text-btn small" disabled={!canReset} onClick={onReset}>Reset to default</button>
      </div>
    </details>
  );
}

// Audio settings (collapsed) + Test whisper + mic tip. Phones: default mic, no output picker
// (the OS sends audio to connected earbuds). The input list only appears once labels are known.
function AudioSettings({ devices, inputId, outputId, setInputId, setOutputId, onTest }) {
  const { inputs, outputs, labeled } = devices;
  const pickOut = showOutputPicker();
  const real = (d) => d.deviceId !== 'default' && d.deviceId !== 'communications';
  const realInputs = inputs.filter(real);
  const showInputs = labeled && realInputs.length > 1;
  // The earbud-mic warning is for laptops (where we pick the output); on phones both mics are fine.
  const warn = pickOut && labeled && inputLooksLikeEarbuds(inputs, outputs, inputId, outputId);
  const label = (id, list) => (id && list.find((d) => d.deviceId === id)?.label) || 'Default';
  const [test, setTest] = useState(null); // null | 'playing' | 'blocked'
  const runTest = async () => {
    setTest('playing');
    const ok = await onTest();
    setTest(ok ? 'playing' : 'blocked');
    if (ok) setTimeout(() => setTest(null), 2500);
  };
  return (
    <>
      <div className="test-row">
        <button className="secondary" onClick={runTest}>Test whisper</button>
        <p className="test-status" aria-live="polite">
          {test === 'playing' ? 'Playing two soft notes…' : test === 'blocked' ? "Couldn't play sound. Check the volume." : 'Plug in earbuds, then check you hear it.'}
        </p>
      </div>
      <p className="tip">Phone mic hears you best, earbud mic hears them best, try both.</p>
      {(showInputs || pickOut) && (
        <details className="devices-wrap">
          <summary>
            <span>Audio settings</span>
            <span className="devices-now">{label(inputId, inputs)}{pickOut ? ` → ${label(outputId, outputs)}` : ''}</span>
          </summary>
          <div className="devices">
            {showInputs && (
              <label>
                <span>Listen with</span>
                <select value={inputId} onChange={(e) => setInputId(e.target.value)}>
                  <option value="">Default mic</option>
                  {realInputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              </label>
            )}
            {pickOut && (
              <label>
                <span>Whisper to</span>
                <select value={outputId} onChange={(e) => setOutputId(e.target.value)}>
                  <option value="">System default</option>
                  {outputs.filter(real).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Output ${i + 1}`}</option>)}
                </select>
              </label>
            )}
          </div>
        </details>
      )}
      {warn && (
        <p className="warn" role="alert">
          Your mic looks like your earbuds, which adds lag on a laptop. Try the laptop mic in Audio settings.
        </p>
      )}
    </>
  );
}

// Pocket mode: near-black overlay that swallows every touch. Only a press-and-hold on the ring
// (UNLOCK_HOLD_MS) unlocks it, so pocket touches cannot end or change anything. The socket,
// mic and whispers keep running underneath.
const UNLOCK_HOLD_MS = 1500;
function PocketMode({ elapsed, note, onUnlock }) {
  const overlayRef = useRef(null);
  const timer = useRef(null);
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    const el = overlayRef.current;
    // Native, non-passive listeners: React's touch handlers are passive and can't preventDefault.
    const block = (e) => { if (e.cancelable) e.preventDefault(); };
    const opts = { passive: false };
    ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'contextmenu', 'dblclick'].forEach((t) => el.addEventListener(t, block, opts));
    el.focus();
    return () => ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'contextmenu', 'dblclick'].forEach((t) => el.removeEventListener(t, block, opts));
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const begin = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.setPointerCapture && e.pointerId !== undefined) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    setHolding(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setHolding(false); onUnlock(); }, UNLOCK_HOLD_MS);
  };
  const cancel = () => {
    clearTimeout(timer.current);
    setHolding(false);
  };
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <div
      className="pocket"
      ref={overlayRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Pocket mode. Press and hold the ring to unlock."
      onPointerDown={swallow}
      onPointerUp={swallow}
      onClick={swallow}
      onKeyDown={swallow}
    >
      <span className="pocket-timer">{fmtClock(elapsed)}{note ? ` · ${note}` : ''}</span>
      <button
        type="button"
        className={`pocket-ring ${holding ? 'holding' : ''}`}
        aria-label="Hold to unlock"
        onPointerDown={begin}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onClick={swallow}
        onKeyDown={swallow}
      >
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="28" className="track" />
          <circle cx="32" cy="32" r="28" className="fill" style={{ transitionDuration: holding ? `${UNLOCK_HOLD_MS}ms` : '200ms' }} />
        </svg>
        <span className="pocket-hint">hold</span>
      </button>
    </div>
  );
}

// The coach line is the product: large, with a mode chip and a soft replace animation.
function CoachLine({ suggestion, handled, connecting }) {
  if (suggestion) {
    return (
      <section className={`coach ${suggestion.mode}`} aria-live="polite">
        <div className="coach-card" key={`${suggestion.text}|${suggestion.latencyMs}`}>
          <span className={`badge ${suggestion.mode}`}>{MODE_LABEL[suggestion.mode] || suggestion.mode}</span>
          <p className="coach-text">{suggestion.text}</p>
        </div>
      </section>
    );
  }
  const idle = connecting ? 'Connecting…' : handled ? 'You handled it' : 'Listening…';
  return (
    <section className="coach idle" aria-live="polite">
      <div className="coach-card" key={idle}>
        <p className="coach-text muted">{idle}</p>
        {!connecting && !handled && <p className="coach-hint">The coach whispers a line if you get stuck.</p>}
      </div>
    </section>
  );
}

function EngagementRow({ engagement, shares }) {
  const sum = shares ? STATES.reduce((a, k) => a + shares[k], 0) : 0;
  const state = engagement?.state;
  return (
    <section className="eng-row" aria-label="How engaged they are">
      <Ring shares={sum > 0 ? shares : null} label="Engagement so far" className="mini" />
      <div className="eng-text">
        <span className={`eng-state ${state || ''}`}>{state ? LABEL[state] : 'Reading the room'}</span>
        <span className="eng-sub">
          {typeof engagement?.talkRatio === 'number' ? `You've talked ${Math.round(engagement.talkRatio * 100)}%` : 'they haven\'t said much yet'}
        </span>
      </div>
    </section>
  );
}

// The only scrolling region. Follows new lines unless the user has scrolled up to read.
function Transcript({ lines }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <section className="transcript" ref={ref} onScroll={onScroll} aria-label="Live transcript, not saved">
      {lines.length === 0 && <p className="empty">The conversation appears here. It isn't saved.</p>}
      {lines.map((l, i) => (
        <p key={i} className={`tline ${l.who} ${l.final ? '' : 'partial'}`}>
          <span className="who">{l.who === 'me' ? 'You' : 'Them'}</span>
          <span className="txt">{l.text}</span>
        </p>
      ))}
    </section>
  );
}

function Metrics({ timing, suggestion }) {
  const ms = timing?.latencyMs ?? suggestion?.latencyMs;
  const slow = typeof ms === 'number' && ms > LATENCY_TARGET_MS;
  const f = (v) => (typeof v === 'number' ? `${Math.round(v)} ms` : '—');
  return (
    <footer className="metrics" aria-label="Demo timings">
      <span>Latency <b className={slow ? 'slow' : ''}>{f(ms)}</b></span>
      <span>Voice <b>{f(timing?.ttsMs)}</b></span>
      <span>Held <b>{f(timing?.heldMs)}</b></span>
    </footer>
  );
}

function LiveView({ live, now, demo, onPocket }) {
  const startedAt = live.getStartedAt();
  // `now` ticks once a second, so it can be slightly older than startedAt right after going live.
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const connecting = live.status === 'connecting';
  const lost = live.status === 'lost';
  const calibrating = live.status === 'calibrating' || live.status === 'calibrate_failed';
  const persona = PERSONAS.find((p) => p.id === (live.personaSet || live.persona))?.label;
  return (
    <>
      <header className="live-head">
        <div className="lh-info">
          <span className={`lh-dot ${lost || live.micPaused ? 'off' : ''}`} aria-hidden="true" />
          <span className="lh-timer">{calibrating ? 'Setting up' : connecting && !startedAt ? '…' : fmtClock(elapsed)}</span>
          {persona && <span className="lh-persona">{persona}</span>}
        </div>
        <button className="end-btn" onClick={live.stop}>End</button>
      </header>
      {live.micPaused && !lost && (
        <button className="banner" onClick={live.resumeMic}>
          <b>Coaching paused.</b> The phone stopped the mic. Tap to resume.
        </button>
      )}
      {lost ? (
        <section className="calib">
          <p className="calib-title">Connection lost</p>
          <p className="calib-text">{live.lostReason} Your conversation is kept; resuming reconnects and relearns your voice.</p>
          <button className="primary start calib-retry" onClick={live.resumeConnection}>Tap to resume</button>
        </section>
      ) : calibrating ? (
        <Calibration live={live} />
      ) : (
        <>
          <CoachLine suggestion={live.suggestion} handled={live.handled} connecting={connecting} />
          <EngagementRow engagement={live.engagement} shares={live.getShares()} />
          <Transcript lines={live.transcript} />
          {demo && <Metrics timing={live.timing} suggestion={live.suggestion} />}
        </>
      )}
      {!lost && !connecting && (
        <button className="pocket-btn" onClick={onPocket}>
          Pocket mode <span>locks the screen, keeps coaching</span>
        </button>
      )}
    </>
  );
}

export default function App() {
  const [sessions, setSessions] = useState(loadSessions);
  const [range, setRange] = useState('day');
  const [demo, setDemo] = useState(() => readFlag('reframe.demo'));
  const onEnd = useCallback((summary) => {
    setSessions((prev) => {
      const next = [summary, ...prev];
      saveSessions(next);
      return next;
    });
  }, []);
  const live = useLive(onEnd);
  const inSession = ['live', 'connecting', 'calibrating', 'calibrate_failed', 'lost'].includes(live.status);
  const [pocket, setPocket] = useState(false);

  // About you: the user's saved edit, else the server default (GET /api/profile-default).
  // If the fetch fails the box starts empty and everything keeps working.
  const [profile, setProfileText] = useState(() => loadSavedProfile() ?? '');
  const [profileDefault, setProfileDefault] = useState(null);
  const [profileFlash, setProfileFlash] = useState(false);
  const editedRef = useRef(loadSavedProfile() !== null);
  const saveTimer = useRef(null);
  const flashTimer = useRef(null);
  const flashSaved = () => {
    setProfileFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setProfileFlash(false), 1500);
  };
  useEffect(() => {
    const ctrl = new AbortController();
    fetchDefaultProfile(ctrl.signal)
      .then((text) => {
        setProfileDefault(text);
        if (!editedRef.current) setProfileText(text);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  useEffect(() => { live.setProfile(profile); }, [profile, live.setProfile]);
  const editProfile = (text) => {
    editedRef.current = true;
    setProfileText(text);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveProfile(text); flashSaved(); }, 500);
  };
  const resetProfile = () => {
    clearTimeout(saveTimer.current);
    editedRef.current = false;
    clearSavedProfile();
    setProfileText(profileDefault ?? '');
    flashSaved();
  };
  // The server confirmed it has the notes (only visible if the box is on screen).
  useEffect(() => { if (live.profileAck?.ok) flashSaved(); }, [live.profileAck]);
  useEffect(() => { if (!inSession) setPocket(false); }, [inSession]);

  // Devices: laptop mic in, earbuds out. Only device ids are remembered.
  const [devices, setDevices] = useState({ inputs: [], outputs: [], labeled: false });
  const [inputId, setInputIdState] = useState(() => loadDevicePref('input'));
  const [outputId, setOutputIdState] = useState(() => loadDevicePref('output'));
  const refreshDevices = useCallback(async () => {
    try {
      const d = await listDevices();
      setDevices(d);
      if (d.labeled) {
        // Default input unless a saved choice still exists.
        setInputIdState((cur) => (cur && d.inputs.some((x) => x.deviceId === cur) ? cur : ''));
        setOutputIdState((cur) => pickOutput(d.outputs, cur));
      }
    } catch { /* no device access */ }
  }, []);
  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);
  useEffect(() => { if (live.status === 'calibrating') refreshDevices(); }, [live.status, refreshDevices]);
  const setInputId = (id) => { setInputIdState(id); saveDevicePref('input', id); };
  const setOutputId = (id) => { setOutputIdState(id); saveDevicePref('output', id); live.setOutputDevice(id); };
  // Called directly in the tap handler so audio and the wake lock unlock inside the gesture.
  const startConversation = () => live.start({ inputId, outputId: showOutputPicker() ? outputId : '' });
  const now = useNow(inSession);

  const toggleDemo = () => {
    setDemo((d) => { writeFlag('reframe.demo', !d); return !d; });
  };

  // Undocumented keyboard shortcut: hold space to force "me" (labels normally come from the server).
  useEffect(() => {
    if (live.status !== 'live' || pocket) return undefined;
    const skip = (t) => t && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName);
    const down = (e) => { if (e.code === 'Space' && !e.repeat && !skip(e.target)) { e.preventDefault(); live.sendSpeaker('me'); } };
    const up = (e) => { if (e.code === 'Space' && !skip(e.target)) { e.preventDefault(); live.sendSpeaker('them'); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [live.status, live.sendSpeaker, pocket]);

  // While in pocket mode, everything behind the overlay is inert (no focus, no clicks, no keys).
  const liveRef = useRef(null);
  useEffect(() => {
    const el = liveRef.current;
    if (!el) return;
    if (pocket) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [pocket, inSession]);
  const startedAt = live.getStartedAt();
  const pocketElapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const pocketNote = live.status === 'lost' ? 'connection lost, unlock to resume' : live.micPaused ? 'paused, unlock to resume' : '';

  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <>
    <div className="blobs" aria-hidden="true"><div className="grp g1"><i className="blob b1" /><i className="blob b2" /></div><div className="grp g2"><i className="blob b3" /><i className="blob b4" /></div></div>
    {inSession ? (
      <>
        <main className="app live" ref={liveRef}>
          <LiveView live={live} now={now} demo={demo} onPocket={() => setPocket(true)} />
        </main>
        {pocket && <PocketMode elapsed={pocketElapsed} note={pocketNote} onUnlock={() => setPocket(false)} />}
      </>
    ) : (
      <main className="app home">
        <header>
          <div>
            <h1>Reframe</h1>
            <p className="date">{today}</p>
          </div>
          <button className={`switch ${demo ? 'on' : ''}`} role="switch" aria-checked={demo} onClick={toggleDemo}>
            <span className="knob" />
            <span className="switch-label">Demo view</span>
          </button>
        </header>

        <section className="intro" aria-labelledby="intro-title">
          <h2 className="intro-title" id="intro-title">Larp a more confident you.</h2>
          <p className="intro-sub">Reframe listens to your conversation and whispers what to say, one line at a time, in your earbud.</p>
          <ol className="steps">
            <li><span className="step-n">1.</span> Put in an earbud.</li>
            <li><span className="step-n">2.</span> Tap Start and talk.</li>
            <li><span className="step-n">3.</span> Hear one line when you need it.</li>
          </ol>
        </section>

        {live.error && <div className="error" role="alert">{live.error}</div>}

        <Report
          sessions={sessions}
          range={range}
          setRange={setRange}
          onClear={() => { clearSessions(); setSessions([]); }}
        />

        <div className="action">
          <section className="setup" aria-label="Before you start">
            <PersonaPicker value={live.persona} onChange={live.setPersona} />
            <AboutYou
              text={profile}
              onChange={editProfile}
              canReset={profileDefault !== null && profile !== profileDefault}
              onReset={resetProfile}
              flash={profileFlash}
            />
            <AudioSettings
              devices={devices}
              inputId={inputId}
              outputId={outputId}
              setInputId={setInputId}
              setOutputId={setOutputId}
              onTest={() => live.testWhisper(outputId)}
            />
          </section>
          <button className="primary start" onClick={startConversation}>Start a conversation</button>
          <p className="privacy">Conversations aren't saved: no audio or words. Your About you notes stay on this device.</p>
        </div>
      </main>
    )}
    </>
  );
}
