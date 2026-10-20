import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, login, sse } from './helpers.js';

let srv, c;
before(async () => {
  srv = await startTestServer();
  c = await login(srv.base);
});
after(() => srv.close());

const open = (id, name) => sse(srv.base, `/api/connect/dealer?device_id=${id}&name=${encodeURIComponent(name)}&type=computer`, c.cookie);

test('devices see each other, share state, relay commands and transfer playback', async () => {
  const a = open('device-aaaa', 'Laptop');
  const b = open('device-bbbb', 'Phone');
  try {
    await a.next('hello');
    await b.next('hello');
    const list = await a.next('devices', (d) => d.length === 2);
    assert.deepEqual(list.data.map((d) => d.name).sort(), ['Laptop', 'Phone']);

    // A starts playing and reports state; B receives it.
    const track = (await c.get('/api/home')).json.popular[0];
    const state = { track_id: track.id, position_ms: 12_000, duration_ms: 60_000, is_playing: true, context: { uri: 'ainos:album:x', title: 'X', track_ids: [track.id] }, index: 0 };
    assert.equal((await c.post('/api/connect/state', { device_id: 'device-aaaa', state })).json.ok, true);
    const seen = await b.next('state', (s) => s.track_id === track.id);
    assert.equal(seen.data.device_id, 'device-aaaa');

    // B cannot hijack state while A is active
    const ignored = await c.post('/api/connect/state', { device_id: 'device-bbbb', state });
    assert.equal(ignored.json.ignored, true);

    // B sends a command; it reaches the active device A.
    await c.post('/api/connect/command', { device_id: 'device-bbbb', command: { type: 'seek', position_ms: 30_000, evil: 'x' } });
    const cmd = await a.next('command');
    assert.deepEqual(cmd.data, { type: 'seek', position_ms: 30_000, from: 'device-bbbb' });
    assert.equal((await c.post('/api/connect/command', { device_id: 'device-bbbb', command: { type: 'rm -rf' } })).status, 400);

    // Transfer to B: A is told to release, B takes over at (about) the same position.
    await c.post('/api/connect/transfer', { device_id: 'device-bbbb' });
    await a.next('release');
    const take = await b.next('take_over');
    assert.equal(take.data.state.track_id, track.id);
    assert.ok(take.data.state.position_ms >= 12_000);
    const devices = (await c.get('/api/connect/devices')).json.devices;
    assert.equal(devices.find((d) => d.id === 'device-bbbb').is_active, true);
  } finally {
    a.close();
    b.close();
  }
});

test('when the active device disconnects, others are told playback stopped', async () => {
  const a = open('device-cccc', 'Desk');
  const b = open('device-dddd', 'Couch');
  try {
    await a.next('hello');
    await b.next('hello');
    const track = (await c.get('/api/home')).json.popular[0];
    await c.post('/api/connect/transfer', { device_id: 'device-cccc' });
    await c.post('/api/connect/state', { device_id: 'device-cccc', state: { track_id: track.id, is_playing: true, position_ms: 0 } });
    a.close();
    const s = await b.next('state', (st) => st && st.device_id === null);
    assert.equal(s.data.is_playing, false);
  } finally {
    b.close();
  }
});

test('the push channel requires a session and a valid device id', async () => {
  const r = await fetch(`${srv.base}/api/connect/dealer?device_id=abc`);
  assert.equal(r.status, 401);
  const r2 = await fetch(`${srv.base}/api/connect/dealer?device_id=bad id!`, { headers: { Cookie: c.cookie } });
  assert.equal(r2.status, 400);
});
