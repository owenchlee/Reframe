// "About me" profile: the only facts the coach may state about the user. Plain text, first-person notes.
// Default: profile.local.txt (gitignored, the real one) or, if missing, profile.example.txt (committed).
// Per session the profile lives in memory only (SessionProfile). Never log profile text.
const fs = require('fs');
const path = require('path');

// Profiles are trimmed and capped at this many characters (default file and client messages).
const PROFILE_MAX_CHARS = 2000;

function normalizeProfile(text) {
  return typeof text === 'string' ? text.trim().slice(0, PROFILE_MAX_CHARS) : '';
}

// Reads the default profile from dir: profile.local.txt, else profile.example.txt, else ''.
// Returns { text, source } where source is the file name used (or 'none').
function loadDefaultProfile(dir = __dirname) {
  for (const name of ['profile.local.txt', 'profile.example.txt']) {
    try {
      return { text: normalizeProfile(fs.readFileSync(path.join(dir, name), 'utf8')), source: name };
    } catch {
      // try the next file
    }
  }
  return { text: '', source: 'none' };
}

// One per socket. set() ignores non-strings (returns null); otherwise returns the stored length.
class SessionProfile {
  constructor(defaultText) {
    this.text = normalizeProfile(defaultText);
  }

  set(text) {
    if (typeof text !== 'string') return null;
    this.text = normalizeProfile(text);
    return this.text.length;
  }
}

module.exports = { PROFILE_MAX_CHARS, normalizeProfile, loadDefaultProfile, SessionProfile };
