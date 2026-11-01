// "About you" notes: written by the user, kept on this device only (localStorage), sent to the
// coach as {type:"profile", text} so it can answer questions about them. Never conversation text.
const KEY = 'reframe.profile.v1';
export const PROFILE_MAX = 2000;

// The user's own edited version, or null if they never edited (then the server default is used).
export function loadSavedProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.text === 'string' ? v.text.slice(0, PROFILE_MAX) : null;
  } catch {
    return null;
  }
}

export function saveProfile(text) {
  try { localStorage.setItem(KEY, JSON.stringify({ text: text.slice(0, PROFILE_MAX) })); } catch { /* storage unavailable */ }
}

// Forget the edit so the (possibly updated) server default shows next time.
export function clearSavedProfile() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

// GET /api/profile-default -> {text}. Relative URL: goes through the dev proxy / tunnel.
export async function fetchDefaultProfile(signal) {
  const res = await fetch('/api/profile-default', { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`profile-default HTTP ${res.status}`);
  const data = await res.json();
  return typeof data?.text === 'string' ? data.text.slice(0, PROFILE_MAX) : '';
}
