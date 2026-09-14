import { displayExamples } from './display.examples.js';
import { formsExamples } from './forms.examples.js';
import type { UiExample } from './types.js';

/** Core gallery cards = forms + display units (main-session aggregator). */
export const coreExamples: readonly UiExample[] = [...formsExamples, ...displayExamples];
