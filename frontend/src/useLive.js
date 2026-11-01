import { useCallback, useEffect, useRef, useState } from 'react';
import { startMicCapture } from './audioCapture.js';
import { createPlayer } from './audioPlayer.js';
import { createTracker } from './sessions.js';

const WS_URL =
  import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`;
const MAX_TRANSCRIPT = 200;
export const CALIBRATE_MS = 8000; // user talks alone this long
const CALIBRATED_TIMEOUT_MS = 6000; // wait this long for {type:"calibrated"} after stop

export const PERSONAS = [
  { id: 'founder', label: 'Founder' },
  { id: 'charmer', label: 'Charmer' },
  { id: 'listener', label: 'Listener' },
  { id: 'funny', label: 'Funny' },
];

// Close codes from the backend (see CLAUDE.md): 1011 = speech-to-text failed / missing keys.
function closeMessage(code, reason) {
  if (code === 1011) return `Speech-to-text stopped${reason ? ` (${reason})` : ''}. Tap Start to try again.`;
  if (code === 1006) return 'Lost the connection to the coach. Is the backend running? Tap Start to try again.';
  return `Connection closed${reason ? ` (${reason})` : ''}. Tap Start to try again.`;
}

// Protocol: see CLAUDE.md "WebSocket protocol" (source of truth).
// status: idle | connecting | calibrating | calibrate_failed | live | error
export function useLive(onEnd) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [engagement, setEngagement] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [handled, setHandled] = useState(false); // last held line was dropped: "you handled it"
  const [timing, setTiming] = useState(null);
  const [speaker, setSpeakerState] = useState('them');
  const [calib, setCalib] = useState({ startedAt: null, waiting: false, reason: null });
  const [persona, setPersonaState] = useState('founder'); // chosen in the UI
  const [personaSet, setPersonaSet] = useState(null); // confirmed by the server

  const wsRef = useRef(null);
  const stopMicRef = useRef(null);
  const playerRef = useRef(null);
  const trackerRef = useRef(null);
  const calibTimers = useRef([]);
  const personaRef = useRef(persona);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  if (!playerRef.current) playerRef.current = createPlayer();

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
    trackerRef.current = createTracker();
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
          // An interim line is replaced by the next interim or the final for it. The server may
          // relabel who between interim and final, so don't require the same speaker.
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

  // Continue without calibration: everything is "them" unless the user holds space / the button.
  const skipCalibration = useCallback(() => {
    setCalib({ startedAt: null, waiting: false, reason: null });
    goLive();
  }, [goLive]);

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
    if (stopMicRef.current) {
      const stopMic = stopMicRef.current;
      stopMicRef.current = null;
      await stopMic();
    }
    playerRef.current.stop();
    setSpeakerState('them');
    setCalib({ startedAt: null, waiting: false, reason: null });
    setStatus('idle');
  }, []);

  // Call from a click handler (needed to unlock audio playback).
  const start = useCallback(async ({ inputId = '', outputId = '' } = {}) => {
    setError(null);
    setStatus('connecting');
    setTranscript([]);
    setEngagement(null);
    setSuggestion(null);
    setHandled(false);
    setTiming(null);
    setPersonaSet(null);
    playerRef.current.unlock();
    if (outputId) playerRef.current.setSink(outputId);

    try {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onmessage = handleMessage;
      ws.onclose = (ev) => {
        if (wsRef.current === ws) {
          const message = closeMessage(ev.code, ev.reason);
          stop().then(() => {
            setError(message);
            setStatus('error');
          });
        }
      };
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error(`Could not reach the coach at ${WS_URL}. Is the backend running?`));
      });
      ws.onerror = null;
      ws.send(JSON.stringify({ type: 'speaker', who: 'them' }));
      ws.send(JSON.stringify({ type: 'persona', id: personaRef.current }));

      stopMicRef.current = await startMicCapture((frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      }, inputId);
      calibrate();
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
  }, [handleMessage, stop, calibrate]);

  const getShares = useCallback(() => trackerRef.current?.shares() || null, []);
  const getStartedAt = useCallback(() => trackerRef.current?.startedAt || null, []);

  const setOutputDevice = useCallback((id) => playerRef.current.setSink(id), []);

  useEffect(() => () => { stop(); }, [stop]);

  return {
    status, error, transcript, engagement, suggestion, handled, timing, speaker, calib, persona, personaSet,
    start, stop, sendSpeaker, setPersona, help, calibrate, skipCalibration, setOutputDevice, getShares, getStartedAt,
  };
}
