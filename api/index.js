// Vercel Function: every /api/* request is rewritten here (see vercel.json).
// The app is created once per instance and reused across requests.
import { createApp } from '../server/app.js';

let appPromise = null;
const getApp = () => {
  appPromise ||= createApp({ dataDir: '/tmp', trustProxy: true }).catch((err) => {
    appPromise = null; // let the next request retry instead of failing forever
    throw err;
  });
  return appPromise;
};

export default async function handler(req, res) {
  // The rewrite passes the original path as ?__path=...; restore it so the router sees /api/<path>.
  const url = new URL(req.url, 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    const pathname = url.pathname.startsWith('/api/index') ? `/api/${original}` : url.pathname;
    req.url = pathname + (url.search || '');
  }
  const app = await getApp();
  return app.handler(req, res);
}
