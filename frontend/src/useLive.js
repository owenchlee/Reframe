import { useCallback, useEffect, useRef, useState } from 'react';
import { createCaptureContext, startMicCapture } from './audioCapture.js';
import { createPlayer } from './audioPlayer.js';
import { createTracker } from './sessions.js';
import { createWakeLock } from './wakeLock.js';

// Same origin's /live (wss on https), proxied to the backend by the dev server; VITE_WS_URL overrides.
const WS_URL =
  import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`;
const MAX_TRANSCRIPT = 200;
export const CALIBRATE_MS = 8000; // user talks alone this long
const CALIBRATED_TIMEOUT_MS = 6000; // wait this long for {type:"calibrated"} after stop
const MIC_CHECK_MS = 2000; // how often to check the mic is still running while in a conversation
// Haptics: a short buzz when a coach line is delivered (where navigator.vibrate exists).
export const HAPTICS = true;
const HAPTIC_PATTERN = [40];

export const PERSONAS = [
  { id: 'founder', label: 'Founder' },
  { id: 'charmer', label: 'Charmer' },
  { id: 'listener', label: 'Listener' },
  { id: 'funny', label: 'Funny' },
];

// Why the socket closed (see CLAUDE.md): 1011 = speech-to-text failed / missing keys.
function closeMessage(code, reason) {
  if (code === 1011) return `Speech-to-text stopped${reason ? ` (${reason})` : ''}.`;
  if (code === 1006) return 'The connection dropped.';
  return `Connection closed${reason ? ` (${reason})` : ''}.`;
}

// Protocol: see CLAUDE.md "WebSocket protocol" (source of truth).
// status: idle | connecting | calibrating | calibrate_failed | live | lost | error
//   lost  = the socket closed mid-conversation; resumeConnection() reconnects and recalibrates.
//   error = could not start at all (back on the home screen).
export function useLive(onEnd) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [lostReason, setLostReason] = useState(null);
  const [micPaused, setMicPaused] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [engagement, setEngagement] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [handled, setHandled] = useState(false); // last held line was dropped: "you handled it"
  const [timing, setTiming] = useState(null);
  const [speaker, setSpeakerState] = useState('them');
  const [calib, setCalib] = useState({ startedAt: null, waiting: false, reason: null });
  const [persona, setPersonaState] = useState('founder'); // chosen in the UI
  const [personaSet, setPersonaSet] = useState(null); // confirmed by the server
  const [profileAck, setProfileAck] = useState(null); // last {ok, chars, at} from profile_set

  const wsRef = useRef(null);
  const micRef = useRef(null); // { stop, isRunning, ctx }
  const ctxRef = useRef(null); // capture AudioContext, created in the Start tap
  const inputRef = useRef('');
  const playerRef = useRef(null);
  const wakeRef = useRef(null);
  const trackerRef = useRef(null);
  const calibTimers = useRef([]);
  const personaRef = useRef(persona);
  const profileRef = useRef(''); // "About you" text, sent on every new socket before calibration
  const profileTimer = useRef(null);
  const profileSentRef = useRef(null); // text the current socket already has (avoids duplicate sends)
  const statusRef = useRef(status);
  statusRef.current = status;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  if (!playerRef.current) playerRef.current = createPlayer();
  if (!wakeRef.current) wakeRef.current = createWakeLock();

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const clearCalibTimers = () => {
    calibTimers.current.forEach(clearTimeout);
    calibTimers.current = [];
  };

  const goLive = useCallback(() => {
    clearCalibTimers();
    if (!trackerRef.current) trackerRef.current = createTracker(); // a resumed session keeps its tracker
    setStatus('live');
  }, []);

  const handleMessage = useCallback((ev) => {
    const player = playerRef.current;
    if (typeof ev.data !== 'string') {
      player.push(ev.data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'transcript':
        setTranscript((prev) => {
          const last = prev[prev.length - 1];
          // An interim line is replaced by the next interim or its final (the label may change).
          const base = last && !last.final ? prev.slice(0, -1) : prev;
          return [...base, { who: msg.who, text: msg.text, final: !!msg.final }].slice(-MAX_TRANSCRIPT);
        });
        break;
      case 'engagement':
        setEngagement(msg);
        trackerRef.current?.onEngagement(msg.state, msg.talkRatio);
        break;
      case 'suggestion': // only delivered lines arrive (stuck detector)
        setSuggestion(msg);
        setHandled(false);
        trackerRef.current?.onSuggestion(msg.mode);
        if (HAPTICS && typeof navigator.vibrate === 'function') {
          try { navigator.vibrate(HAPTIC_PATTERN); } catch { /* ignore */ }
        }
        break;
      case 'suggestion_dropped':
        setSuggestion(null);
        setHandled(true);
        break;
      case 'timing':
        setTiming(msg);
        break;
      case 'audio_start':
        player.begin();
        break;
      case 'audio_end':
        player.end();
        break;
      case 'audio_stop': // stale whisper: stop now, drop queued chunks (also after audio_end)
        player.stop();
        break;
      case 'calibrated':
        if (msg.ok) {
          setCalib({ startedAt: null, waiting: false, reason: null });
          goLive();
        } else {
          clearCalibTimers();
          setCalib({ startedAt: null, waiting: false, reason: msg.reason || 'Calibration failed' });
          setStatus('calibrate_failed');
        }
        break;
      case 'persona_set':
        setPersonaSet(msg.id);
        break;
      case 'profile_set': // errors are ignored quietly; the UI keeps working
        setProfileAck({ ok: !!msg.ok, chars: msg.chars, at: Date.now() });
        break;
      default:
        break;
    }
  }, [goLive]);

  const sendSpeaker = useCallback((who) => {
    setSpeakerState(who);
    send({ type: 'speaker', who });
  }, [send]);

  const setPersona = useCallback((id) => {
    setPersonaState(id);
    personaRef.current = id;
    send({ type: 'persona', id });
  }, [send]);

  const help = useCallback(() => send({ type: 'help' }), [send]);

  // "About you": remembered for the next socket; if a conversation is running, resend (debounced).
  const setProfile = useCallback((text) => {
    profileRef.current = text;
    clearTimeout(profileTimer.current);
    profileTimer.current = setTimeout(() => {
      const text = profileRef.current;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && text !== profileSentRef.current) {
        profileSentRef.current = text;
        send({ type: 'profile', text });
      }
    }, 800);
  }, [send]);

  // Calibration: the user talks alone for CALIBRATE_MS, then we ask the server for the result.
  const calibrate = useCallback(() => {
    clearCalibTimers();
    setStatus('calibrating');
    setCalib({ startedAt: Date.now(), waiting: false, reason: null });
    send({ type: 'calibrate', action: 'start' });
    calibTimers.current.push(setTimeout(() => {
      send({ type: 'calibrate', action: 'stop' });
      setCalib((c) => ({ ...c, waiting: true }));
      calibTimers.current.push(setTimeout(() => {
        setCalib({ startedAt: null, waiting: false, reason: 'No answer from the coach. Try again.' });
        setStatus('calibrate_failed');
      }, CALIBRATED_TIMEOUT_MS));
    }, CALIBRATE_MS));
  }, [send]);

  // Continue without calibration: everything is "them" unless space is held.
  const skipCalibration = useCallback(() => {
    setCalib({ startedAt: null, waiting: false, reason: null });
    goLive();
  }, [goLive]);

  const startMic = useCallback(async () => {
    if (micRef.current) await micRef.current.stop().catch(() => {});
    micRef.current = await startMicCapture((frame) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
    }, { deviceId: inputRef.current, ctx: ctxRef.current });
  }, []);

  const stop = useCallback(async () => {
    clearCalibTimers();
    const tracker = trackerRef.current;
    trackerRef.current = null;
    if (tracker) {
      const summary = tracker.finish();
      if (summary.durationSec >= 5) onEndRef.current?.(summary);
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) ws.close();
    const mic = micRef.current;
    micRef.current = null;
    if (mic) await mic.stop().catch(() => {});
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) ctx.close().catch(() => {});
    wakeRef.current.disable();
    playerRef.current.stop();
    setSpeakerState('them');
    setCalib({ startedAt: null, waiting: false, reason: null });
    setMicPaused(false);
    setLostReason(null);
    setStatus('idle');
  }, []);

  // Open the socket; on a mid-conversation close switch to "lost" instead of ending.
  const connect = useCallback(async () => {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    ws.onmessage = handleMessage;
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return; // closed by us
      wsRef.current = null;
      clearCalibTimers();
      playerRef.current.stop();
      setLostReason(closeMessage(ev.code, ev.reason));
      setStatus('lost');
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Could not reach the coach at ${WS_URL}. Is the backend running?`));
    });
    ws.onerror = null;
    ws.send(JSON.stringify({ type: 'speaker', who: 'them' }));
    ws.send(JSON.stringify({ type: 'persona', id: personaRef.current }));
    // Profile goes right after the socket opens and before calibration starts, exactly once; a
    // pending "changed" resend for the old socket is cancelled.
    clearTimeout(profileTimer.current);
    profileSentRef.current = profileRef.current;
    ws.send(JSON.stringify({ type: 'profile', text: profileRef.current }));
  }, [handleMessage]);

  // Call directly from the Start tap: the synchronous part unlocks audio on phones.
  const start = useCallback(async ({ inputId = '', outputId = '' } = {}) => {
    // --- synchronous, inside the gesture ---
    playerRef.current.unlock();
    if (outputId) playerRef.current.setSink(outputId);
    if (!ctxRef.current) ctxRef.current = createCaptureContext();
    wakeRef.current.enable();
    inputRef.current = inputId;
    // --- async ---
    setError(null);
    setLostReason(null);
    setMicPaused(false);
    setStatus('connecting');
    setTranscript([]);
    setEngagement(null);
    setSuggestion(null);
    setHandled(false);
    setTiming(null);
    setPersonaSet(null);
    setProfileAck(null);
    try {
      await connect();
      await startMic();
      goLive(); // straight into the conversation; voice enrollment happens quietly
    } catch (err) {
      const denied = err && err.name === 'NotAllowedError';
      const missing = err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
      const message = denied
        ? 'Microphone permission denied'
        : missing ? 'That microphone is not available. Pick another input.' : err.message || 'Failed to start';
      await stop();
      setError(message);
      setStatus('error');
    }
  }, [connect, startMic, goLive, stop]);

  // "Connection lost, tap to resume": reconnect, make sure the mic runs, recalibrate.
  const resumeConnection = useCallback(async () => {
    const ctx = ctxRef.current;
    const resumed = ctx && ctx.state !== 'running' ? ctx.resume().catch(() => {}) : null; // inside the tap
    playerRef.current.unlock();
    setStatus('connecting');
    try {
      await resumed;
      await connect();
      if (!micRef.current || !micRef.current.isRunning()) await startMic();
      setMicPaused(false);
      goLive();
    } catch (err) {
      setLostReason(err.message || 'Still offline.');
      setStatus('lost');
    }
  }, [connect, startMic, goLive]);

  // "Coaching paused, tap to resume": the browser stopped the mic while the page was hidden.
  const resumeMic = useCallback(async () => {
    const ctx = ctxRef.current;
    const resumed = ctx && ctx.state !== 'running' ? ctx.resume().catch(() => {}) : null; // inside the tap
    playerRef.current.unlock();
    try {
      await resumed;
      if (!micRef.current || !micRef.current.isRunning()) await startMic();
      setMicPaused(!micRef.current.isRunning());
    } catch (err) {
      setError(err && err.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Could not restart the microphone');
    }
  }, [startMic]);

  // Detect a stopped mic: on returning to the page, and periodically during a conversation.
  useEffect(() => {
    const active = ['calibrating', 'calibrate_failed', 'live'].includes(status);
    if (!active) return undefined;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const mic = micRef.current;
      if (mic && !mic.isRunning()) setMicPaused(true);
    };
    document.addEventListener('visibilitychange', check);
    const id = setInterval(check, MIC_CHECK_MS);
    return () => { document.removeEventListener('visibilitychange', check); clearInterval(id); };
  }, [status]);

  const testWhisper = useCallback((outputId) => {
    if (outputId) playerRef.current.setSink(outputId);
    return playerRef.current.test();
  }, []);

  const getShares = useCallback(() => trackerRef.current?.shares() || null, []);
  const getStartedAt = useCallback(() => trackerRef.current?.startedAt || null, []);

  const setOutputDevice = useCallback((id) => playerRef.current.setSink(id), []);

  useEffect(() => () => { stop(); }, [stop]);

  return {
    status, error, lostReason, micPaused, transcript, engagement, suggestion, handled, timing, speaker, calib, persona, personaSet,
    profileAck, start, stop, sendSpeaker, setPersona, setProfile, help, calibrate, skipCalibration, resumeConnection, resumeMic, testWhisper,
    setOutputDevice, getShares, getStartedAt,
  };
}
