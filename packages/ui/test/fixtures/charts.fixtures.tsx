import { ProgressRing } from '../../src/charts/progress-ring.js';
import { DonutChart } from '../../src/charts/donut-chart.js';
import { BarList } from '../../src/charts/bar-list.js';
import type { Fixture } from './types.js';

/** Axe fixtures for the hand-written SVG chart primitives (P26b F2 charts). */
export const chartsFixtures: readonly Fixture[] = [
  {
    name: 'ProgressRing',
    render: () => (
      <ProgressRing value={62} label="Fleet health 62 of 100">
        <span className="text-lg font-semibold">62</span>
      </ProgressRing>
    ),
  },
  {
    name: 'DonutChart',
    render: () => (
      <DonutChart
        segments={[
          { id: 'sent', label: 'Sent', value: 60, tone: 'success' },
          { id: 'failed', label: 'Failed', value: 15, tone: 'danger' },
          { id: 'waiting', label: 'Waiting', value: 25, tone: 'info' },
        ]}
        label="Today's outcomes"
        centre={<span className="text-sm">100 messages</span>}
      />
    ),
  },
  {
    name: 'BarList',
    render: () => (
      <BarList
        rows={[
          { id: '1', label: 'Number one', value: 40, max: 100, tone: 'success' },
          {
            id: '2',
            label: 'Number two',
            value: 10,
            max: 100,
            tone: 'info',
            href: '/instances/2',
          },
        ]}
      />
    ),
  },
];
