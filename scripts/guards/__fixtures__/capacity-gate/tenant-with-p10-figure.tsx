// Fixture: a dirty tenant-facing component that leaks a P10 measured
// capacity figure (WARNING 9, FIX-P10-A) - this must turn
// check-capacity-gate.ts red.
export function CapacityFixtureP10Dirty(): string {
  return 'Each session costs about 0.227 MB of memory once connected.';
}
