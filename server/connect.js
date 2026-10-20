// "Connect": multi-device playback control. Every open client keeps a
// long-lived push channel to the server (Spotify's desktop client uses a
// websocket "dealer" plus a "connect-state" service; we use Server-Sent
// Events). One device per user is the active player; any other device can
// send it commands, see its live state, or take over playback (transfer).

import { HttpError } from './http.js';

const COMMANDS = new Set(['pause', 'resume', 'next', 'previous', 'seek', 'volume', 'shuffle', 'repeat', 'play', 'queue']);

export class ConnectHub {
  constructor() {
    this.users = new Map(); // userId -> { devices: Map, state, activeId }
    this.heartbeat = setInterval(() => this.#ping(), 20000);
    this.heartbeat.unref?.();
  }

  #user(userId) {
    let u = this.users.get(userId);
    if (!u) {
      u = { devices: new Map(), state: null, activeId: null };
      this.users.set(userId, u);
    }
    return u;
  }

  #send(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client went away; cleanup happens on 'close' */
    }
  }

  #ping() {
    for (const u of this.users.values()) for (const d of u.devices.values()) {
      try { d.res.write(': ping\n\n'); } catch { /* ignore */ }
    }
  }

  devices(userId) {
    const u = this.#user(userId);
    return [...u.devices.values()].map((d) => ({ id: d.id, name: d.name, type: d.type, is_active: d.id === u.activeId, volume: d.volume, connected_at: d.connectedAt }));
  }

  #broadcastDevices(userId) {
    const u = this.#user(userId);
    const list = this.devices(userId);
    for (const d of u.devices.values()) this.#send(d.res, 'devices', list);
  }

  /** Attach an SSE stream for a device. */
  open(userId, req, res, { id, name, type }) {
    if (!/^[\w-]{6,64}$/.test(id || '')) throw new HttpError(400, 'Invalid device_id');
    const u = this.#user(userId);
    const old = u.devices.get(id);
    if (old) { try { old.res.end(); } catch { /* ignore */ } }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const device = { id, name: String(name || 'Web Player').slice(0, 40), type: ['computer', 'smartphone', 'tablet', 'speaker'].includes(type) ? type : 'computer', res, volume: 1, connectedAt: Date.now() };
    u.devices.set(id, device);
    this.#send(res, 'hello', { device_id: id, active_device_id: u.activeId, state: u.state });
    this.#broadcastDevices(userId);
    req.on('close', () => {
      if (u.devices.get(id) !== device) return;
      u.devices.delete(id);
      if (u.activeId === id) {
        u.activeId = null;
        if (u.state) u.state = { ...u.state, is_playing: false, device_id: null };
        for (const d of u.devices.values()) this.#send(d.res, 'state', u.state);
      }
      this.#broadcastDevices(userId);
    });
  }

  /** The active device reports its playback state; fan out to the others. */
  reportState(userId, deviceId, state) {
    const u = this.#user(userId);
    if (!u.devices.has(deviceId)) throw new HttpError(409, 'Device not connected');
    if (u.activeId && u.activeId !== deviceId && !state.claim) {
      return { ignored: true, active_device_id: u.activeId };
    }
    const changedActive = u.activeId !== deviceId;
    u.activeId = deviceId;
    u.state = sanitizeState(state, deviceId);
    const dev = u.devices.get(deviceId);
    if (dev && Number.isFinite(state.volume)) dev.volume = state.volume;
    for (const d of u.devices.values()) if (d.id !== deviceId) this.#send(d.res, 'state', u.state);
    if (changedActive) this.#broadcastDevices(userId);
    return { ok: true };
  }

  command(userId, fromDeviceId, cmd) {
    const u = this.#user(userId);
    if (!cmd || !COMMANDS.has(cmd.type)) throw new HttpError(400, 'Unknown command');
    const target = u.devices.get(u.activeId);
    if (!target) throw new HttpError(404, 'No active device', 'no_active_device');
    this.#send(target.res, 'command', { ...pick(cmd), from: fromDeviceId });
    return { ok: true, target: target.id };
  }

  /** Move playback to another device, carrying the full player state. */
  transfer(userId, toDeviceId, { play = true } = {}) {
    const u = this.#user(userId);
    const to = u.devices.get(toDeviceId);
    if (!to) throw new HttpError(404, 'Target device not connected');
    const from = u.devices.get(u.activeId);
    const state = u.state ? { ...u.state } : null;
    if (state && state.is_playing && Number.isFinite(state.timestamp)) {
      state.position_ms = Math.min(state.duration_ms || Infinity, state.position_ms + (Date.now() - state.timestamp));
    }
    if (from && from.id !== to.id) this.#send(from.res, 'release', { to: to.id });
    u.activeId = to.id;
    this.#send(to.res, 'take_over', { state, play });
    this.#broadcastDevices(userId);
    return { ok: true, active_device_id: to.id };
  }

  stats() {
    let devices = 0, active = 0;
    for (const u of this.users.values()) { devices += u.devices.size; if (u.activeId) active++; }
    return { users: this.users.size, devices, active_players: active };
  }

  close() {
    clearInterval(this.heartbeat);
    for (const u of this.users.values()) for (const d of u.devices.values()) { try { d.res.end(); } catch { /* ignore */ } }
  }
}

function pick(cmd) {
  const out = { type: cmd.type };
  if (Number.isFinite(cmd.position_ms)) out.position_ms = Math.max(0, cmd.position_ms);
  if (Number.isFinite(cmd.volume)) out.volume = Math.max(0, Math.min(1, cmd.volume));
  if (typeof cmd.shuffle === 'boolean') out.shuffle = cmd.shuffle;
  if (['off', 'context', 'track'].includes(cmd.repeat)) out.repeat = cmd.repeat;
  if (cmd.context && typeof cmd.context === 'object') out.context = sanitizeContext(cmd.context);
  if (Number.isInteger(cmd.index)) out.index = cmd.index;
  if (typeof cmd.track_id === 'string') out.track_id = cmd.track_id.slice(0, 40);
  return out;
}

function sanitizeContext(c) {
  return {
    uri: typeof c.uri === 'string' ? c.uri.slice(0, 120) : null,
    title: typeof c.title === 'string' ? c.title.slice(0, 120) : '',
    track_ids: Array.isArray(c.track_ids) ? c.track_ids.filter((x) => typeof x === 'string').slice(0, 500) : [],
  };
}

function sanitizeState(s, deviceId) {
  return {
    device_id: deviceId,
    track_id: typeof s.track_id === 'string' ? s.track_id : null,
    position_ms: Number.isFinite(s.position_ms) ? s.position_ms : 0,
    duration_ms: Number.isFinite(s.duration_ms) ? s.duration_ms : 0,
    is_playing: !!s.is_playing,
    shuffle: !!s.shuffle,
    repeat: ['off', 'context', 'track'].includes(s.repeat) ? s.repeat : 'off',
    volume: Number.isFinite(s.volume) ? s.volume : 1,
    context: s.context ? sanitizeContext(s.context) : null,
    index: Number.isInteger(s.index) ? s.index : 0,
    order: Array.isArray(s.order) ? s.order.filter(Number.isInteger).slice(0, 500) : null,
    user_queue: Array.isArray(s.user_queue) ? s.user_queue.filter((x) => typeof x === 'string').slice(0, 100) : [],
    timestamp: Date.now(),
  };
}
