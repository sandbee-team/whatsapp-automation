// Planted violation fixture (P15 Unit U3) - never real production code.
export function disableTlsVerificationGlobally(): void {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
