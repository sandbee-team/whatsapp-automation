import { dataFixtures } from './data.fixtures.js';
import { popupsFixtures } from './popups.fixtures.js';
import type { Fixture } from './types.js';

/** Overlay axe fixtures = popups + data units (main-session aggregator). */
export const overlayFixtures: readonly Fixture[] = [...popupsFixtures, ...dataFixtures];
