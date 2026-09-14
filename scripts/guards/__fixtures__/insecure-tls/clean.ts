import https from 'node:https';

// Clean fixture (P15 Unit U3) - normal TLS request, verification untouched.
export function secureRequest(): void {
  https.request({ host: 'example.com' }, () => undefined);
}
