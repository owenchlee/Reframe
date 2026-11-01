import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from './useLive.js';
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

function HoldToTalk({ speaker, onChange }) {
  const me = speaker === 'me';
  return (
    <button
      className={`hold ${me ? 'on' : ''}`}
      aria-pressed={me}
      onClick={() => onChange(me ? 'them' : 'me')}
      onContextMenu={(e) => e.preventDefault()}
    >
      {me ? 'You are talking · tap when done' : 'Tap when you start talking'}
    </button>
  );
}

function LiveScreen({ live, now }) {
  const startedAt = live.getStartedAt();
  const shares = live.getShares();
  const sum = shares ? STATES.reduce((a, k) => a + shares[k], 0) : 0;
  const pct = sum > 0 ? toPercents(shares) : null;
  const elapsed = startedAt ? (now - startedAt) / 1000 : 0;
  const connecting = live.status === 'connecting';
  return (
    <>
      <Ring shares={pct ? shares : null} label="Conversation in progress">
        <div className="hero">{connecting ? '…' : fmtClock(elapsed)}</div>
        <div className="hero-sub">{connecting ? 'connecting' : 'listening · coach is in your earbuds'}</div>
      </Ring>
      <Legend rows={stateRows(pct)} />
      {!connecting && <HoldToTalk speaker={live.speaker} onChange={live.sendSpeaker} />}
    </>
  );
}

function DemoPanel({ live }) {
  const { suggestion, timing, engagement, transcript } = live;
  const ms = timing?.latencyMs ?? suggestion?.latencyMs;
  const slow = typeof ms === 'number' && ms > LATENCY_TARGET_MS;
  const linesRef = useRef(null);
  useEffect(() => {
    if (linesRef.current) linesRef.current.scrollTop = linesRef.current.scrollHeight;
  }, [transcript]);
  return (
    <section className="demo">
      <h2>Demo view</h2>
      <div className={`say ${suggestion?.mode || ''}`}>
        {suggestion && <span className={`badge ${suggestion.mode}`}>{MODE_LABEL[suggestion.mode] || suggestion.mode}</span>}
        <p className="say-text">{suggestion ? suggestion.text : 'Waiting for the conversation…'}</p>
      </div>
      <Legend
        rows={[
          { label: 'Reading', color: `var(--${engagement?.state || 'muted'})`, value: engagement ? LABEL[engagement.state] : '—' },
          { label: 'You talk', color: 'var(--accent)', value: typeof engagement?.talkRatio === 'number' ? `${Math.round(engagement.talkRatio * 100)}%` : '—' },
          { label: 'Latency', color: slow ? 'var(--danger)' : 'var(--engaged)', value: typeof ms === 'number' ? `${Math.round(ms)} ms` : '—' },
          { label: 'Voice', color: 'var(--muted)', value: typeof timing?.ttsMs === 'number' ? `${Math.round(timing.ttsMs)} ms` : '—' },
        ]}
      />
      {engagement?.reasons?.length > 0 && (
        <div className="chips">
          {engagement.reasons.map((r, i) => <span className="chip" key={i}>{r}</span>)}
        </div>
      )}
      <div className="lines" ref={linesRef} aria-label="Live transcript, not saved">
        {transcript.length === 0 && <p className="empty">Transcript appears here. It isn't saved.</p>}
        {transcript.map((l, i) => (
          <p key={i} className={`line ${l.who} ${l.final ? '' : 'partial'}`}>
            <b>{l.who === 'me' ? 'You' : 'Them'}</b> {l.text}
          </p>
        ))}
      </div>
    </section>
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
  const inSession = live.status === 'live' || live.status === 'connecting';
  const now = useNow(inSession);

  const toggleDemo = () => {
    setDemo((d) => { writeFlag('reframe.demo', !d); return !d; });
  };

  // Laptop demo: hold space to mark "me" speaking.
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
    <main className="app">
      <header>
        <div>
          <h1>{inSession ? 'In conversation' : 'Reframe'}</h1>
          <p className="date">{today}</p>
        </div>
        <button className={`switch ${demo ? 'on' : ''}`} role="switch" aria-checked={demo} onClick={toggleDemo}>
          <span className="knob" />
          <span className="switch-label">Demo view</span>
        </button>
      </header>

      {live.error && <div className="error" role="alert">{live.error}</div>}

      {inSession ? (
        <LiveScreen live={live} now={now} />
      ) : (
        <Report
          sessions={sessions}
          range={range}
          setRange={setRange}
          onClear={() => { clearSessions(); setSessions([]); }}
        />
      )}

      {demo && <DemoPanel live={live} />}

      <div className="action">
        {inSession ? (
          <button className="primary stop" onClick={live.stop}>End conversation</button>
        ) : (
          <button className="primary start" onClick={live.start}>Start a conversation</button>
        )}
      </div>
    </main>
    </>
  );
}
