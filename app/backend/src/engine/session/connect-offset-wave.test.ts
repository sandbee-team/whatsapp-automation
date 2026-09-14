import { describe, expect, it } from 'vitest';
import { createWaveConnectTracker, CONNECT_OFFSET_WAVE_THRESHOLD } from './connect-offset-wave.js';

/**
 * connect-offset-wave.test.ts (P09 U6b) - pure unit coverage for the
 * wave-vs-ordinary-churn counting rule `session-worker-composition.ts`'s
 * discovery `grab` wrapper consults. No I/O, no fake timers needed.
 */

describe('createWaveConnectTracker', () => {
  it('small_grabs_connect_immediately: attempts at/under the threshold are never wave-tagged', () => {
    const tracker = createWaveConnectTracker(CONNECT_OFFSET_WAVE_THRESHOLD);
    tracker.beginCycle();

    const results: boolean[] = [];
    for (let i = 0; i < CONNECT_OFFSET_WAVE_THRESHOLD; i += 1) {
      results.push(tracker.noteGrabAttempt());
    }

    expect(results.every((isWave) => isWave === false)).toBe(true);
  });

  it('attempts past the threshold within the same cycle are wave-tagged', () => {
    const tracker = createWaveConnectTracker(CONNECT_OFFSET_WAVE_THRESHOLD);
    tracker.beginCycle();

    for (let i = 0; i < CONNECT_OFFSET_WAVE_THRESHOLD; i += 1) {
      expect(tracker.noteGrabAttempt()).toBe(false);
    }
    // The (threshold + 1)th, (threshold + 2)th... attempts this SAME cycle.
    expect(tracker.noteGrabAttempt()).toBe(true);
    expect(tracker.noteGrabAttempt()).toBe(true);
  });

  it('beginCycle resets the counter - a new cycle is never tainted by the previous one', () => {
    const tracker = createWaveConnectTracker(CONNECT_OFFSET_WAVE_THRESHOLD);
    tracker.beginCycle();
    for (let i = 0; i < CONNECT_OFFSET_WAVE_THRESHOLD + 3; i += 1) {
      tracker.noteGrabAttempt();
    }

    tracker.beginCycle();
    for (let i = 0; i < CONNECT_OFFSET_WAVE_THRESHOLD; i += 1) {
      expect(tracker.noteGrabAttempt()).toBe(false);
    }
  });
});
