import { displayFixtures } from './display.fixtures.js';
import { formsFixtures } from './forms.fixtures.js';
import type { Fixture } from './types.js';

/** Core axe fixtures = forms + display units (main-session aggregator). */
export const coreFixtures: readonly Fixture[] = [...formsFixtures, ...displayFixtures];
