// Client side of "Connect": a push channel (Server-Sent Events) through which
// this device learns about other devices, receives commands when it is the
// active player, and gets told to take over or release playback.
import { api } from './api.js';

export function deviceIdentity() {
  let id;
  try { id = localStorage.getItem('ainos.device_id'); } catch { /* ignore */ }
  if (!id) {
    id = 'web-' + crypto.getRandomValues(new Uint32Array(3)).join('-').slice(0, 30);
    try { localStorage.setItem('ainos.device_id', id); } catch { /* ignore */ }
  }
  // Each browser tab is its own device, so two tabs can control each other.
  let tab = sessionStorage.getItem('ainos.tab');
  if (!tab) { tab = Math.random().toString(36).slice(2, 6); sessionStorage.setItem('ainos.tab', tab); }
  const ua = navigator.userAgent;
  const type = /Mobi|Android|iPhone/.test(ua) ? 'smartphone' : /iPad|Tablet/.test(ua) ? 'tablet' : 'computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  let name;
  try { name = localStorage.getItem('ainos.device_name'); } catch { /* ignore */ }
  return { id: `${id}-${tab}`, type, name: name || `${browser}${os ? ' on ' + os : ''} · ${tab}` };
}

export class Connect extends EventTarget {
  constructor(player, identity) {
    super();
    this.player = player;
    this.identity = identity;
    this.devices = [];
    this.connected = false;
    this.es = null;
    this.pending = null;
    this.timer = null;
  }

  start() {
    const { id, name, type } = this.identity;
    const qs = new URLSearchParams({ device_id: id, name, type });
    this.es = new EventSource(`/api/connect/dealer?${qs}`);
    this.es.addEventListener('open', () => { this.connected = true; this.#emit(); });
    this.es.addEventListener('error', () => { this.connected = false; this.#emit(); });
    this.es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      if (d.active_device_id && d.active_device_id !== id && d.state) this.player.onRemoteState(d.state);
      else if (!d.active_device_id && d.state && !this.player.track) this.player.resumeState = d.state;
      if (d.active_device_id === id) this.player.reportState(true);
    });
    this.es.addEventListener('devices', (e) => { this.devices = JSON.parse(e.data); this.#emit(); });
    this.es.addEventListener('state', (e) => this.player.onRemoteState(JSON.parse(e.data)));
    this.es.addEventListener('command', (e) => this.player.onRemoteCommand(JSON.parse(e.data)));
    this.es.addEventListener('take_over', (e) => this.player.onTakeOver(JSON.parse(e.data)));
    this.es.addEventListener('release', () => this.player.onRelease());
  }

  stop() {
    this.es?.close();
  }

  /** Throttled state report (latest wins). */
  report(state) {
    this.pending = state;
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const s = this.pending;
      this.pending = null;
      try { await api.post('/api/connect/state', { device_id: this.identity.id, state: s }); } catch { /* offline: ignore */ }
    }, 250);
  }

  async command(command) {
    try {
      await api.post('/api/connect/command', { device_id: this.identity.id, command });
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }

  async transfer(deviceId) {
    await api.post('/api/connect/transfer', { device_id: deviceId, play: true });
  }

  deviceName(id) {
    return this.devices.find((d) => d.id === id)?.name || 'another device';
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }
}
