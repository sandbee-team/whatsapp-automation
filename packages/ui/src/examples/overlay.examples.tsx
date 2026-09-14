import { dataExamples } from './data.examples.js';
import { popupsExamples } from './popups.examples.js';
import type { UiExample } from './types.js';

/** Overlay gallery cards = popups + data units (main-session aggregator). */
export const overlayExamples: readonly UiExample[] = [...popupsExamples, ...dataExamples];
