import https from 'node:https';

// Planted violation fixture (P15 Unit U3) - never real production code.
export function insecureRequest(): void {
  https.request({ host: 'example.com', rejectUnauthorized: false }, () => undefined);
}
