// KNOWN-BAD FIXTURE (P29a security-scan guard proof) - this file intentionally
// disables TLS certificate verification in an https.request options object so
// the semgrep `wp.no-tls-verification-disabled` rule has something real to
// fire on. Never copy this shape into real source (see also
// scripts/check-no-insecure-tls.ts, which forbids the same pattern).
import https from 'node:https';

export function fetchInsecurely(host: string): void {
  const options = {
    host,
    port: 443,
    path: '/',
    rejectUnauthorized: false,
  };
  https.request(options).end();
}
