import { useCallback, useEffect, useRef, useState } from 'react';
import { startMicCapture } from './audioCapture.js';
import { createPlayer } from './audioPlayer.js';
import { createTracker } from './sessions.js';

const WS_URL =
  import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`;
const MAX_TRANSCRIPT = 200;

// Protocol: see CLAUDE.md "WebSocket protocol" (source of truth).
export function useLive(onEnd) {
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [engagement, setEngagement] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [timing, setTiming] = useState(null);
  const [speaker, setSpeakerState] = useState('them');

  const wsRef = useRef(null);
  const stopMicRef = useRef(null);
  const playerRef = useRef(null);
  const trackerRef = useRef(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  if (!playerRef.current) playerRef.current = createPlayer();

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
          // Replace the in-progress (non-final) line from the same speaker.
          const base = last && !last.final && last.who === msg.who ? prev.slice(0, -1) : prev;
          return [...base, { who: msg.who, text: msg.text, final: !!msg.final }].slice(-MAX_TRANSCRIPT);
        });
        break;
      case 'engagement':
        setEngagement(msg);
        trackerRef.current?.onEngagement(msg.state, msg.talkRatio);
        break;
      case 'suggestion':
        setSuggestion(msg);
        trackerRef.current?.onSuggestion(msg.mode);
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
      case 'audio_stop':
        player.stop();
        break;
      default:
        break;
    }
  }, []);

  const sendSpeaker = useCallback((who) => {
    setSpeakerState(who);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'speaker', who }));
    }
  }, []);

  const stop = useCallback(async () => {
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
      await stopMicRef.current();
      stopMicRef.current = null;
    }
    playerRef.current.stop();
    setSpeakerState('them');
    setStatus('idle');
  }, []);

  // Call from a click handler (needed to unlock audio playback).
  const start = useCallback(async () => {
    setError(null);
    setStatus('connecting');
    setTranscript([]);
    setEngagement(null);
    setSuggestion(null);
    setTiming(null);
    playerRef.current.unlock();

    try {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onmessage = handleMessage;
      ws.onclose = () => {
        if (wsRef.current === ws) {
          setError('Connection lost');
          stop();
          setStatus('error');
        }
      };
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error(`Could not reach ${WS_URL}`));
      });
      ws.send(JSON.stringify({ type: 'speaker', who: 'them' }));

      stopMicRef.current = await startMicCapture((frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      });
      trackerRef.current = createTracker();
      setStatus('live');
    } catch (err) {
      const denied = err && err.name === 'NotAllowedError';
      const message = denied ? 'Microphone permission denied' : err.message || 'Failed to start';
      await stop();
      setError(message);
      setStatus('error');
    }
  }, [handleMessage, stop]);

  const getShares = useCallback(() => trackerRef.current?.shares() || null, []);
  const getStartedAt = useCallback(() => trackerRef.current?.startedAt || null, []);

  const setOutputDevice = useCallback((id) => playerRef.current.setSink(id), []);

  useEffect(() => () => { stop(); }, [stop]);

  return { status, error, transcript, engagement, suggestion, timing, speaker, start, stop, sendSpeaker, setOutputDevice, getShares, getStartedAt };
}
