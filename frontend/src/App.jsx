import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLive, PERSONAS, CALIBRATE_MS } from './useLive.js';
import {
  canPickOutput, inputLooksLikeEarbuds, listDevices, loadDevicePref, pickInput, pickOutput, saveDevicePref, unlockLabels,
} from './devices.js';
import Ring from './Ring.jsx';
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

function DevicePicker({ devices, inputId, outputId, setInputId, setOutputId, onUnlock }) {
  const { inputs, outputs, labeled } = devices;
  const warn = labeled && inputLooksLikeEarbuds(inputs, outputs, inputId, outputId);
  const name = (d, i, kind) => d.label || `${kind} ${i + 1}`;
  const short = (id, list) => (id && list.find((d) => d.deviceId === id)?.label) || 'System default';
  const real = (d) => d.deviceId !== 'default' && d.deviceId !== 'communications';
  return (
    <>
      <details className="devices-wrap">
        <summary>
          <span>Audio settings</span>
          <span className="devices-now">{short(inputId, inputs)} → {canPickOutput() ? short(outputId, outputs) : 'system output'}</span>
        </summary>
        <div className="devices">
          <label>
            <span>Listen with (laptop mic)</span>
            <select value={inputId} onChange={(e) => setInputId(e.target.value)}>
              <option value="">System default</option>
              {inputs.filter(real).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{name(d, i, 'Microphone')}</option>)}
            </select>
          </label>
          {canPickOutput() && (
            <label>
              <span>Whisper to (earbuds)</span>
              <select value={outputId} onChange={(e) => setOutputId(e.target.value)}>
                <option value="">System default</option>
                {outputs.filter(real).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{name(d, i, 'Output')}</option>)}
              </select>
            </label>
          )}
          {!labeled && <button className="text-btn small" onClick={onUnlock}>Show device names</button>}
        </div>
      </details>
      {warn && (
        <p className="warn" role="alert">
          Your mic looks like your earbuds. Earbud mics drop to call quality and add lag: pick the laptop mic in Audio settings.
        </p>
      )}
    </>
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

function LiveView({ live, now, demo }) {
  const startedAt = live.getStartedAt();
  // `now` ticks once a second, so it can be slightly older than startedAt right after going live.
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const connecting = live.status === 'connecting';
  const calibrating = live.status === 'calibrating' || live.status === 'calibrate_failed';
  const persona = PERSONAS.find((p) => p.id === (live.personaSet || live.persona))?.label;
  return (
    <>
      <header className="live-head">
        <div className="lh-info">
          <span className="lh-dot" aria-hidden="true" />
          <span className="lh-timer">{calibrating ? 'Setting up' : connecting ? '…' : fmtClock(elapsed)}</span>
          {persona && <span className="lh-persona">{persona}</span>}
        </div>
        <button className="end-btn" onClick={live.stop}>End</button>
      </header>
      {calibrating ? (
        <Calibration live={live} />
      ) : (
        <>
          <CoachLine suggestion={live.suggestion} handled={live.handled} connecting={connecting} />
          <EngagementRow engagement={live.engagement} shares={live.getShares()} />
          <Transcript lines={live.transcript} />
          {demo && <Metrics timing={live.timing} suggestion={live.suggestion} />}
        </>
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
  const inSession = ['live', 'connecting', 'calibrating', 'calibrate_failed'].includes(live.status);

  // Devices: laptop mic in, earbuds out. Only device ids are remembered.
  const [devices, setDevices] = useState({ inputs: [], outputs: [], labeled: false });
  const [inputId, setInputIdState] = useState(() => loadDevicePref('input'));
  const [outputId, setOutputIdState] = useState(() => loadDevicePref('output'));
  const refreshDevices = useCallback(async () => {
    try {
      const d = await listDevices();
      setDevices(d);
      if (d.labeled) {
        setInputIdState((cur) => pickInput(d.inputs, cur || loadDevicePref('input')));
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
  const unlock = async () => { try { await unlockLabels(); } catch { /* denied */ } refreshDevices(); };
  const startConversation = () => live.start({ inputId, outputId });
  const now = useNow(inSession);

  const toggleDemo = () => {
    setDemo((d) => { writeFlag('reframe.demo', !d); return !d; });
  };

  // Undocumented keyboard shortcut: hold space to force "me" (labels normally come from the server).
  useEffect(() => {
    if (live.status !== 'live') return undefined;
    const skip = (t) => t && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName);
    const down = (e) => { if (e.code === 'Space' && !e.repeat && !skip(e.target)) { e.preventDefault(); live.sendSpeaker('me'); } };
    const up = (e) => { if (e.code === 'Space' && !skip(e.target)) { e.preventDefault(); live.sendSpeaker('them'); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [live.status, live.sendSpeaker]);

  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <>
    <div className="blobs" aria-hidden="true"><div className="grp g1"><i className="blob b1" /><i className="blob b2" /></div><div className="grp g2"><i className="blob b3" /><i className="blob b4" /></div></div>
    {inSession ? (
      <main className="app live">
        <LiveView live={live} now={now} demo={demo} />
      </main>
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
            <DevicePicker
              devices={devices}
              inputId={inputId}
              outputId={outputId}
              setInputId={setInputId}
              setOutputId={setOutputId}
              onUnlock={unlock}
            />
          </section>
          <button className="primary start" onClick={startConversation}>Start a conversation</button>
        </div>
      </main>
    )}
    </>
  );
}
