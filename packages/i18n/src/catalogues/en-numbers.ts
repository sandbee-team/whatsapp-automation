import type { Catalogue } from './catalogue-type.js';

/** English strings for the 2026-09-08 numbers screen + instance card refresh; hi-numbers.ts mirrors every key. */
export const enNumbers = {
  'instances.summary.connected': 'Connected',
  'instances.summary.needsAttention': 'Needs attention',
  'instances.summary.parked': 'Parked',

  'instances.card.stats.queued': 'Queued',
  'instances.card.stats.nextSend': 'Next send',
  'instances.card.stats.window': 'Window',

  'instances.connect.limitOrNoPlan.title': 'This workspace cannot add a number yet',
  'instances.connect.limitOrNoPlan.body':
    'Your workspace has no plan assigned, or it has used every number its plan allows. Ask your administrator to assign or upgrade the plan, then try again.',
  'instances.connect.limitOrNoPlan.help': 'Nothing was lost. No number was created.',
} as const satisfies Catalogue;
