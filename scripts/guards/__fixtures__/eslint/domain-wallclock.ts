/**
 * Fixture: wp/domain-no-wallclock (P00 step 5), scoped to packages/domain/**.
 *
 * BAD: Date.now(), Math.random(), new Date() with no arguments - @wp/domain
 * must run unchanged in a browser and stay pure; clock and RNG are always
 * injected by the caller.
 * GOOD: clock/RNG injected by the caller.
 */
export function badNow(): number {
  return Date.now();
}

export function badRandom(): number {
  return Math.random();
}

export function badNewDate(): Date {
  return new Date();
}

interface Clock {
  now(): number;
}

export function goodNow(clock: Clock): number {
  return clock.now();
}

export function goodNewDate(clock: Clock): Date {
  return new Date(clock.now());
}
