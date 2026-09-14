// Fixture: a dirty tenant-facing component that leaks a measured capacity
// bracket figure - this must turn check-capacity-gate.ts red.
export function CapacityFixtureDirty(): string {
  return 'Each session costs about 18 MB of memory once connected.';
}
