// Security headers every response must carry (spec S9, S26), checked by the
// smoke test on each deployment. Pure, so the tests can feed it headers.

/** Problems with one response's headers (a Headers object); empty when all is well. */
export function headerProblems(headers, { https = false } = {}) {
  const problems = [];
  const csp = headers.get('content-security-policy');
  if (!csp) problems.push('Content-Security-Policy is missing');
  else {
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => /^script-src\s/i.test(d));
    if (!scriptSrc) problems.push('CSP has no script-src');
    else if (/'unsafe-inline'|'unsafe-eval'/i.test(scriptSrc)) problems.push(`CSP script-src allows unsafe code: ${scriptSrc}`);
  }
  const referrer = headers.get('referrer-policy');
  if (referrer !== 'strict-origin-when-cross-origin') problems.push(`Referrer-Policy is ${referrer ?? 'missing'}, expected strict-origin-when-cross-origin`);
  const nosniff = headers.get('x-content-type-options');
  if (nosniff !== 'nosniff') problems.push(`X-Content-Type-Options is ${nosniff ?? 'missing'}, expected nosniff`);
  if (https) {
    const hsts = headers.get('strict-transport-security');
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts || '')?.[1] || 0);
    if (!maxAge) problems.push(`Strict-Transport-Security is ${hsts ?? 'missing'}`);
  }
  return problems;
}
