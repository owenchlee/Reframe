// Profile tests. Run: npm run test:profile (from backend/)
// Unit: default loading (local -> example -> none), the 2000-char cap, per-session isolation.
// Integration: starts its own server on PORT=3005 (needs the API keys in .env for sockets to stay
// open), checks GET /api/profile-default, profile_set replies on two sockets, and that no profile
// text appears in the server's console output. Prints only lengths and pass/fail, never profile text.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { PROFILE_MAX_CHARS, normalizeProfile, loadDefaultProfile, SessionProfile } = require('../profile');

const PORT = 3005;
const BACKEND = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reframe-profile-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await test('loading: profile.local.txt wins over the example', () => {
    const dir = tempDir({ 'profile.local.txt': '  local notes  ', 'profile.example.txt': 'example notes' });
    assert.deepStrictEqual(loadDefaultProfile(dir), { text: 'local notes', source: 'profile.local.txt' });
    fs.rmSync(dir, { recursive: true });
  });
  await test('loading: local missing -> profile.example.txt', () => {
    const dir = tempDir({ 'profile.example.txt': 'example notes\n' });
    assert.deepStrictEqual(loadDefaultProfile(dir), { text: 'example notes', source: 'profile.example.txt' });
    fs.rmSync(dir, { recursive: true });
  });
  await test('loading: neither file -> empty profile', () => {
    const dir = tempDir({});
    assert.deepStrictEqual(loadDefaultProfile(dir), { text: '', source: 'none' });
    fs.rmSync(dir, { recursive: true });
  });
  await test('the committed example exists and is non-empty', () => {
    assert.ok(fs.readFileSync(path.join(BACKEND, 'profile.example.txt'), 'utf8').trim().length > 50);
  });
  await test('cap: trimmed and capped at 2000 characters (default file too)', () => {
    assert.strictEqual(PROFILE_MAX_CHARS, 2000);
    assert.strictEqual(normalizeProfile(`  ${'x'.repeat(3000)}  `).length, 2000);
    assert.strictEqual(normalizeProfile('  hi  '), 'hi');
    assert.strictEqual(normalizeProfile(42), '');
    const dir = tempDir({ 'profile.local.txt': 'y'.repeat(2500) });
    assert.strictEqual(loadDefaultProfile(dir).text.length, 2000);
    fs.rmSync(dir, { recursive: true });
  });
  await test('session isolation (unit): two sessions keep their own profile; non-strings ignored', () => {
    const a = new SessionProfile('default');
    const b = new SessionProfile('default');
    assert.strictEqual(a.set('profile A'), 9);
    assert.strictEqual(b.text, 'default');
    assert.strictEqual(b.set('profile B, longer'), 17);
    assert.strictEqual(a.text, 'profile A');
    assert.strictEqual(a.set(null), null);
    assert.strictEqual(a.set({ text: 'x' }), null);
    assert.strictEqual(a.text, 'profile A');
  });

  // ---- integration ----
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), LD_LIBRARY_PATH: path.join(BACKEND, 'node_modules', 'sherpa-onnx-linux-x64') },
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  for (let i = 0; i < 50 && !logs.join('').includes('listening'); i++) await sleep(100);
  const markerA = 'Zanzibar-marker-A: I collect vintage typewriters.';
  const markerB = 'Quokka-marker-B: I surf every Sunday at dawn, rain or shine.';

  await test('GET /api/profile-default returns {text} with the default profile', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/profile-default`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(Object.keys(body), ['text']);
    assert.strictEqual(body.text, loadDefaultProfile(BACKEND).text);
  });

  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/live`);
    ws.msgs = [];
    ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d.toString())); });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const nextProfileSet = async (ws, n) => {
    for (let i = 0; i < 40; i++) {
      const got = ws.msgs.filter((m) => m.type === 'profile_set');
      if (got.length >= n) return got[n - 1];
      await sleep(50);
    }
    return null;
  };

  await test('profile / profile_set on two sockets: each gets its own reply; cap and non-strings', async () => {
    const a = await open();
    const b = await open();
    await sleep(300);
    if (a.readyState !== WebSocket.OPEN) throw new Error('socket closed by server (API keys missing in .env?)');
    a.send(JSON.stringify({ type: 'profile', text: `  ${markerA}  ` }));
    b.send(JSON.stringify({ type: 'profile', text: markerB }));
    assert.deepStrictEqual(await nextProfileSet(a, 1), { type: 'profile_set', ok: true, chars: markerA.length });
    assert.deepStrictEqual(await nextProfileSet(b, 1), { type: 'profile_set', ok: true, chars: markerB.length });
    a.send(JSON.stringify({ type: 'profile', text: 12345 })); // ignored: no reply
    a.send(JSON.stringify({ type: 'profile', text: 'z'.repeat(3000) }));
    assert.deepStrictEqual(await nextProfileSet(a, 2), { type: 'profile_set', ok: true, chars: 2000 });
    assert.strictEqual(a.msgs.filter((m) => m.type === 'profile_set').length, 2, 'non-string got a reply');
    assert.strictEqual(b.msgs.filter((m) => m.type === 'profile_set').length, 1, 'socket B saw socket A replies');
    a.close();
    b.close();
    await sleep(300);
  });

  child.kill();
  await sleep(300);
  await test('no profile text in the server console output', () => {
    const out = logs.join('');
    assert.ok(out.includes('listening'), 'server did not start');
    const secrets = [markerA, markerB, 'Zanzibar', 'Quokka', 'z'.repeat(50)];
    // Every line of the default profile, and distinctive pieces of it.
    for (const line of loadDefaultProfile(BACKEND).text.split('\n')) if (line.trim()) secrets.push(line.trim().slice(0, 30));
    const leaked = secrets.filter((s) => out.includes(s));
    assert.strictEqual(leaked.length, 0, `${leaked.length} profile snippet(s) found in logs`);
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
