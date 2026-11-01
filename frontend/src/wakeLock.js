// Keep the screen awake during a conversation (a sleeping phone can stop the mic).
// Uses the Screen Wake Lock API and re-acquires it when the page becomes visible again (the
// browser drops it whenever the page is hidden). Fallback where the API is missing: a 2x2 muted
// looping canvas video, which keeps most mobile browsers awake. Call enable() inside a user
// gesture so the fallback video is allowed to play.
export function createWakeLock() {
  let wanted = false;
  let sentinel = null;
  let video = null;
  let drawTimer = null;

  const startFallback = () => {
    if (video) return;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const g = canvas.getContext('2d');
    if (!canvas.captureStream) return;
    video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', left: '0', top: '0' });
    video.srcObject = canvas.captureStream(1);
    document.body.appendChild(video);
    let on = false;
    const draw = () => { on = !on; g.fillStyle = on ? '#010101' : '#000'; g.fillRect(0, 0, 2, 2); };
    draw();
    drawTimer = setInterval(draw, 1000);
    video.play().catch(() => {});
  };

  const stopFallback = () => {
    clearInterval(drawTimer);
    drawTimer = null;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.remove();
      video = null;
    }
  };

  const acquire = async () => {
    if (!wanted || sentinel) return;
    if (navigator.wakeLock && navigator.wakeLock.request) {
      try {
        const s = await navigator.wakeLock.request('screen');
        if (!wanted) { s.release().catch(() => {}); return; }
        sentinel = s;
        s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
        return;
      } catch {
        // denied (e.g. low battery or page hidden): fall through to the fallback
      }
    }
    startFallback();
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') acquire();
  };

  return {
    enable() {
      if (wanted) return;
      wanted = true;
      document.addEventListener('visibilitychange', onVisibility);
      if (!(navigator.wakeLock && navigator.wakeLock.request)) startFallback(); // synchronously, in the gesture
      acquire();
    },
    disable() {
      wanted = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) sentinel.release().catch(() => {});
      sentinel = null;
      stopFallback();
    },
  };
}
