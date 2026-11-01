// Audio device selection: laptop mic in, earbuds out. Only device ids are remembered (no audio).
const IN_KEY = 'reframe.inputDevice';
const OUT_KEY = 'reframe.outputDevice';
const BUILT_IN = /built-?in|internal|macbook|laptop|integrated|array/i;
const BLUETOOTH = /bluetooth|airpods|buds|headset|hands-?free|bt\b/i;

export function loadDevicePref(kind) {
  try { return localStorage.getItem(kind === 'input' ? IN_KEY : OUT_KEY) || ''; } catch { return ''; }
}
export function saveDevicePref(kind, id) {
  try { localStorage.setItem(kind === 'input' ? IN_KEY : OUT_KEY, id || ''); } catch { /* ignore */ }
}

export const canPickOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// Lists inputs/outputs. Labels are empty until mic permission has been granted once.
export async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], labeled: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === 'audioinput');
  const outputs = all.filter((d) => d.kind === 'audiooutput');
  return { inputs, outputs, labeled: all.some((d) => d.label) };
}

// Asks for mic permission once so device labels become visible, then releases the mic.
export async function unlockLabels() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
}

// Default input: the saved choice if it still exists, else a built-in mic, else the system default.
export function pickInput(inputs, saved) {
  if (saved && inputs.some((d) => d.deviceId === saved)) return saved;
  const builtIn = inputs.find((d) => BUILT_IN.test(d.label) && !BLUETOOTH.test(d.label));
  return builtIn ? builtIn.deviceId : '';
}

export function pickOutput(outputs, saved) {
  return saved && outputs.some((d) => d.deviceId === saved) ? saved : '';
}

// True if the chosen input looks like the earbuds (same physical device as the output, or a
// Bluetooth headset mic): those drop to call quality and add lag.
export function inputLooksLikeEarbuds(inputs, outputs, inputId, outputId) {
  const input = inputs.find((d) => d.deviceId === inputId) || inputs.find((d) => d.deviceId === 'default');
  if (!input) return false;
  const output = outputs.find((d) => d.deviceId === outputId);
  if (output && output.groupId && input.groupId && output.groupId === input.groupId && outputId && outputId !== 'default') return true;
  return BLUETOOTH.test(input.label);
}
