import { Badge } from '../../src/badge.js';
import { StatusDot } from '../../src/status-dot.js';
import { Avatar } from '../../src/avatar.js';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardBody,
  CardFooter,
} from '../../src/card.js';
import { KpiStat } from '../../src/kpi-stat.js';
import { Skeleton, SkeletonText, SkeletonRows } from '../../src/skeleton.js';
import { EmptyState } from '../../src/empty-state.js';
import { ErrorState } from '../../src/error-state.js';
import { Spinner } from '../../src/spinner.js';
import { Separator } from '../../src/separator.js';
import { Alert } from '../../src/alert.js';
import type { Fixture } from './types.js';

/** Axe fixtures for the display primitives (P26b U1b-2 display primitives (badge, avatar, card, kpi-stat, skeleton, empty/error state, alert)). */
export const displayFixtures: readonly Fixture[] = [
  {
    name: 'Badge (dot)',
    render: () => (
      <Badge tone="success" dot>
        Live
      </Badge>
    ),
  },
  { name: 'StatusDot', render: () => <StatusDot tone="success" label="Live" pulse /> },
  { name: 'Avatar', render: () => <Avatar name="Priya Sharma" /> },
  {
    name: 'Card (restyled)',
    render: () => (
      <Card interactive>
        <CardHeader actions={<button type="button">Manage</button>}>
          <CardTitle>Dashboard</CardTitle>
          <CardDescription>An overview of your connected numbers.</CardDescription>
        </CardHeader>
        <CardBody>12 numbers connected.</CardBody>
        <CardFooter>
          <button type="button">Continue</button>
        </CardFooter>
      </Card>
    ),
  },
  {
    name: 'KpiStat',
    render: () => (
      <KpiStat
        label="Connected numbers"
        value="12"
        hint="of 20 planned"
        delta={{ text: '+2 vs last week', direction: 'up' }}
      />
    ),
  },
  {
    name: 'KpiStat (loading)',
    render: () => <KpiStat label="Connected numbers" value="12" loading />,
  },
  { name: 'Skeleton', render: () => <Skeleton className="h-4 w-24" /> },
  { name: 'SkeletonText', render: () => <SkeletonText lines={3} /> },
  { name: 'SkeletonRows', render: () => <SkeletonRows rows={2} columns={3} /> },
  {
    name: 'EmptyState',
    render: () => (
      <EmptyState
        title="No numbers connected yet"
        body="Connect a number to get started."
        action={<button type="button">Connect a number</button>}
        secondaryAction={<button type="button">Learn more</button>}
      />
    ),
  },
  {
    name: 'ErrorState',
    render: () => (
      <ErrorState
        title="Couldn't load connected numbers"
        body="Check your connection and try again."
        retryAction={<button type="button">Retry</button>}
        details="request_id=abc123"
      />
    ),
  },
  { name: 'Spinner (lg)', render: () => <Spinner aria-label="Loading" size="lg" /> },
  { name: 'Separator (labelled)', render: () => <Separator label="or" /> },
  {
    name: 'Alert',
    render: () => (
      <Alert
        tone="warning"
        title="Safe mode is on"
        body="Sends are paced to protect your numbers."
        onDismiss={() => {}}
        dismissLabel="Dismiss"
      />
    ),
  },
];
