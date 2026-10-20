import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export async function readJson(req, limit = 256 * 1024) {
  const type = req.headers['content-type'] || '';
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  // sendBeacon posts text/plain; everything else must be JSON.
  if (!type.startsWith('application/json') && !type.startsWith('text/plain')) {
    throw new HttpError(415, 'Expected application/json');
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Resolve a request path inside root, refusing traversal. */
export function safeJoin(root, reqPath) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, '.' + path.posix.normalize('/' + reqPath));
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

export function serveFile(req, res, file, { cacheControl = 'no-cache', headers = {} } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': mimeFor(file),
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    ETag: etag,
    ...headers,
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

/**
 * Serve a file with HTTP Range support (single range). This is what lets the
 * player start on the first chunk, seek anywhere, and prefetch the beginning
 * of the next track without downloading whole files.
 */
export function serveRange(req, res, file, contentType, extraHeaders = {}) {
  const stat = fs.statSync(file);
  const size = stat.size;
  const base = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    ...extraHeaders,
  };
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start, end;
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') {
      const suffix = Number(m[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
  }
  if (start === undefined || start > end || start >= size) {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}
