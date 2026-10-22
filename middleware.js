// Vercel Routing Middleware: audio is served as static files, but only through
// the HMAC-signed, expiring URLs the manifest API hands out (same check as
// verifyMediaSignature in server/auth.js).
import { next } from '@vercel/functions';

export const config = { matcher: '/media/:path*' };

const enc = new TextEncoder();
let keyPromise = null;
const hmacKey = () => (keyPromise ||= crypto.subtle.importKey('raw', enc.encode(process.env.AINOS_SECRET || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const valid = /^\/media\/(low|high)\/[A-Za-z0-9]{22}\.wav$/.test(url.pathname) && exp && sig && /^\d+$/.test(exp) && Number(exp) >= Date.now() / 1000;
  if (valid && process.env.AINOS_SECRET) {
    const expected = base64url(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(`${url.pathname}:${exp}`)));
    if (sameString(expected, sig)) return next({ headers: { 'Cache-Control': 'private, max-age=3600' } });
  }
  return new Response(JSON.stringify({ error: { status: 403, message: 'Invalid or expired media signature' } }), {
    status: 403,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
