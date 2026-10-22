import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generateCatalog } from '../scripts/generate.js';
import { createApp } from '../server/app.js';

/** Fresh catalog (short tracks) + running server on a random port. */
export async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-test-'));
  await generateCatalog({ dataDir, quick: true, quiet: true });
  const app = await createApp({ dataDir, databaseUrl: null, log: () => {}, authAttemptsPerMinute: 10_000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app, base, dataDir,
    async close() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal cookie-keeping client. */
export function client(base) {
  let cookie = '';
  const req = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return {
    get: (u, h) => req('GET', u, undefined, h),
    post: (u, b = {}, h) => req('POST', u, b, h),
    put: (u, h) => req('PUT', u, undefined, h),
    patch: (u, b) => req('PATCH', u, b),
    del: (u) => req('DELETE', u),
    get cookie() { return cookie; },
  };
}

export async function login(base, username = 'demo', password = 'ainos-demo') {
  const c = client(base);
  const r = await c.post('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  return c;
}

export async function signup(base, username, password = 'correct horse battery') {
  const c = client(base);
  const r = await c.post('/api/auth/signup', { username, password });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${r.text}`);
  return c;
}

/** Server-Sent Events reader that collects events into an array. */
export function sse(base, url, cookie) {
  const events = [];
  const waiters = [];
  const reqObj = http.get(base + url, { headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!ev) continue;
        const item = { event: ev, data: data ? JSON.parse(data) : null };
        events.push(item);
        for (const w of waiters.slice()) if (w.match(item)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(item); }
      }
    });
  });
  return {
    events,
    next(event, pred = () => true, ms = 3000) {
      const hit = events.find((e) => e.event === event && pred(e.data) && !e.taken);
      if (hit) { hit.taken = true; return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const w = { match: (e) => e.event === event && pred(e.data), resolve: (e) => { e.taken = true; clearTimeout(t); resolve(e); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timeout waiting for ${event}`)); }, ms);
        waiters.push(w);
      });
    },
    close() { reqObj.destroy(); },
  };
}
