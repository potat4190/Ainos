// Security headers every response must carry (spec S9, S26), checked by the
// smoke test on each deployment. Pure, so the tests can feed it headers.

// A header sent twice (e.g. by vercel.json and by the function) arrives
// joined with ", "; identical copies are fine.
const tokens = (headers, name) => (headers.get(name) || '').split(',').map((s) => s.trim()).filter(Boolean);
const single = (headers, name) => {
  const unique = [...new Set(tokens(headers, name))];
  return unique.length === 1 ? unique[0] : unique.length ? unique.join(', ') : null;
};

/** Problems with one response's headers (a Headers object); empty when all is well. */
export function headerProblems(headers, { https = false } = {}) {
  const problems = [];
  // Each comma-separated entry is a separate policy, and browsers enforce all of them.
  const policies = tokens(headers, 'content-security-policy').map((p) => p.split(';').map((d) => d.trim()).filter(Boolean));
  if (!policies.length) problems.push('Content-Security-Policy is missing');
  for (const directives of policies) {
    const scriptSrc = directives.find((d) => /^script-src\s/i.test(d));
    if (!scriptSrc) problems.push('CSP has no script-src');
    else if (/'unsafe-inline'|'unsafe-eval'/i.test(scriptSrc)) problems.push(`CSP script-src allows unsafe code: ${scriptSrc}`);
  }
  if (policies.length && !policies.some((ds) => ds.some((d) => /^frame-ancestors\s+'none'$/i.test(d)))) problems.push("CSP lacks frame-ancestors 'none' (clickjacking)");
  const expect = (name, label, value) => {
    const got = single(headers, name);
    if (got !== value) problems.push(`${label} is ${got ?? 'missing'}, expected ${value}`);
  };
  expect('referrer-policy', 'Referrer-Policy', 'strict-origin-when-cross-origin');
  expect('x-content-type-options', 'X-Content-Type-Options', 'nosniff');
  expect('cross-origin-opener-policy', 'Cross-Origin-Opener-Policy', 'same-origin');
  if (https) {
    const hsts = headers.get('strict-transport-security');
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts || '')?.[1] || 0);
    if (!maxAge) problems.push(`Strict-Transport-Security is ${hsts ?? 'missing'}`);
  }
  return problems;
}
