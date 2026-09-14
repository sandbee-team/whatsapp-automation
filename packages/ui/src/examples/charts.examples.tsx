import { ProgressRing } from '../charts/progress-ring.js';
import { DonutChart } from '../charts/donut-chart.js';
import { BarList } from '../charts/bar-list.js';
import type { UiExample } from './types.js';

/** Gallery cards for the hand-written SVG chart primitives (P26b F2). */
export const chartsExamples: readonly UiExample[] = [
  {
    name: 'ProgressRing / sizes and tones',
    group: 'Charts',
    render: () => (
      <div className="flex items-end gap-4">
        <ProgressRing value={40} size="sm" tone="accent" label="Fleet health 40 of 100">
          <span className="text-xs font-semibold">40</span>
        </ProgressRing>
        <ProgressRing value={62} size="md" tone="success" label="Fleet health 62 of 100">
          <span className="text-lg font-semibold">62</span>
        </ProgressRing>
        <ProgressRing value={85} size="lg" tone="warning" label="Fleet health 85 of 100">
          <span className="text-2xl font-semibold">85</span>
        </ProgressRing>
      </div>
    ),
  },
  {
    name: 'DonutChart / segments',
    group: 'Charts',
    render: () => (
      <DonutChart
        segments={[
          { id: 'sent', label: 'Sent', value: 60, tone: 'success' },
          { id: 'failed', label: 'Failed', value: 15, tone: 'danger' },
          { id: 'waiting', label: 'Waiting', value: 25, tone: 'info' },
        ]}
        label="Today's outcomes"
        centre={
          <span className="flex flex-col items-center">
            <span className="text-xl font-semibold">100</span>
            <span className="text-xs text-muted">messages</span>
          </span>
        }
      />
    ),
  },
  {
    name: 'DonutChart / all zero',
    group: 'Charts',
    render: () => (
      <DonutChart
        segments={[
          { id: 'sent', label: 'Sent', value: 0, tone: 'success' },
          { id: 'failed', label: 'Failed', value: 0, tone: 'danger' },
          { id: 'waiting', label: 'Waiting', value: 0, tone: 'info' },
        ]}
        label="Today's outcomes"
        centre={<span className="text-xs text-muted">Nothing sent yet today</span>}
      />
    ),
  },
  {
    name: 'BarList / rows',
    group: 'Charts',
    render: () => (
      <BarList
        rows={[
          { id: '1', label: 'Support line', value: 82, max: 100, tone: 'success' },
          {
            id: '2',
            label: 'Sales line',
            value: 95,
            max: 100,
            tone: 'warning',
            meta: 'waiting 4',
            href: '/instances/2',
          },
          { id: '3', label: 'Marketing line', value: 20, max: 100, tone: 'info' },
          { id: '4', label: 'Ops line', value: 5, max: 100, tone: 'danger' },
        ]}
      />
    ),
  },
  {
    name: 'BarList / empty',
    group: 'Charts',
    render: () => <BarList rows={[]} emptyMessage="Connect a number to see sending activity." />,
  },
];
