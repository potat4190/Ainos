// The deployment smoke test (scripts/smoke.js) must itself work: run it
// against a local server, and check its header rules on their own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers.js';
import { headerProblems } from '../scripts/check-headers.js';

const SMOKE = fileURLToPath(new URL('../scripts/smoke.js', import.meta.url));
const good = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=63072000',
};
const problems = (overrides, opts) => headerProblems(new Headers(Object.entries({ ...good, ...overrides }).filter(([, v]) => v !== null)), opts);

test('header check: passes good headers, names each problem', () => {
  assert.deepEqual(problems({}, { https: true }), []);
  assert.deepEqual(problems({ 'strict-transport-security': null }), [], 'HSTS only matters over HTTPS');
  assert.match(problems({ 'strict-transport-security': null }, { https: true }).join(), /Strict-Transport-Security is missing/);
  assert.match(problems({ 'strict-transport-security': 'max-age=0' }, { https: true }).join(), /Strict-Transport-Security/);
  assert.match(problems({ 'content-security-policy': null }).join(), /Content-Security-Policy is missing/);
  assert.match(problems({ 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'" }).join(), /unsafe code/);
  assert.match(problems({ 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval'" }).join(), /unsafe code/);
  assert.deepEqual(problems({ 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" }), [], 'only script-src is checked for unsafe-inline');
  assert.match(problems({ 'content-security-policy': "default-src 'self'" }).join(), /no script-src/);
  assert.match(problems({ 'referrer-policy': 'same-origin' }).join(), /Referrer-Policy is same-origin/);
  assert.match(problems({ 'x-content-type-options': null }).join(), /X-Content-Type-Options is missing/);
});

let srv;
before(async () => { srv = await startTestServer(); });
after(() => srv.close());

test('scripts/smoke.js passes against a running server', async () => {
  const { code, out } = await new Promise((resolve) => {
    execFile(process.execPath, [SMOKE, srv.base], { timeout: 120_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr }));
  });
  assert.equal(code, 0, out.split('\n').filter((l) => l.startsWith('FAIL')).join('\n') || out.slice(-2000));
  assert.match(out, /ok {3}security headers on \//);
  assert.match(out, /All checks passed/);
});
