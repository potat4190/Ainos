// Media URLs are signed by the API (server/auth.js) and checked twice: by the
// local server (auth.js) and, on Vercel, by middleware.js with Web Crypto.
// Both must agree, including during a secret rotation, when the previous
// secret still verifies URLs signed before the switch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { signMediaPath, verifyMediaSignature } from '../server/auth.js';

// middleware.js needs @vercel/functions, a production-only dependency; local
// runs without npm install skip that half.
const middleware = await import('../middleware.js').then((m) => m.default, () => null);

const PATH = '/media/high/AbCdEfGhIjKlMnOpQrStUv.wav';
const OLD = 'old-secret-'.repeat(4);
const NEW = 'new-secret-'.repeat(4);
const params = (signed) => new URL(signed, 'http://x').searchParams;
const verify = (secrets, signed, path = PATH) => verifyMediaSignature(secrets, path, params(signed).get('exp'), params(signed).get('sig'));

const saved = { current: process.env.AINOS_SECRET, previous: process.env.AINOS_SECRET_PREVIOUS };
after(() => {
  for (const [k, v] of [['AINOS_SECRET', saved.current], ['AINOS_SECRET_PREVIOUS', saved.previous]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const allowed = async (signed) => {
  const res = await middleware(new Request(`https://ainos.example${signed}`));
  return res.headers.get('x-middleware-next') === '1' && res.status !== 403;
};

test('server: URLs signed with the previous secret verify only while it is configured', () => {
  const fromOld = signMediaPath(OLD, PATH);
  assert.equal(verify(NEW, fromOld), false, 'after the switch, without the previous secret');
  assert.equal(verify([NEW, OLD], fromOld), true, 'during the overlap');
  assert.equal(verify([NEW, undefined], signMediaPath(NEW, PATH)), true, 'no previous secret configured');
  assert.equal(verify([NEW, 'other-secret'], fromOld), false);
  assert.equal(verify([NEW, OLD], fromOld, PATH.replace('high', 'low')), false, 'the signature covers the path');
  assert.equal(verify([NEW, OLD], signMediaPath(OLD, PATH, -10)), false, 'expired');
});

test('middleware agrees with the server, including during a rotation', { skip: !middleware && 'needs npm install (@vercel/functions)' }, async () => {
  process.env.AINOS_SECRET = NEW;
  delete process.env.AINOS_SECRET_PREVIOUS;
  assert.equal(await allowed(signMediaPath(NEW, PATH)), true, 'a URL signed by the API with the current secret');
  assert.equal(await allowed(signMediaPath(OLD, PATH)), false, 'previous secret not configured');
  process.env.AINOS_SECRET_PREVIOUS = OLD;
  assert.equal(await allowed(signMediaPath(OLD, PATH)), true, 'previous secret during the overlap');
  assert.equal(await allowed(signMediaPath(NEW, PATH)), true);
  assert.equal(await allowed(signMediaPath('other-secret', PATH)), false);
  assert.equal(await allowed(signMediaPath(NEW, PATH, -10)), false, 'expired');
  assert.equal(await allowed(PATH), false, 'unsigned');
  delete process.env.AINOS_SECRET;
  assert.equal(await allowed(signMediaPath(OLD, PATH)), false, 'nothing verifies without a current secret');
});
