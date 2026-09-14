/** exports-display.ts (P26b U1b-2 display primitives (badge, avatar, card, kpi-stat, skeleton, empty/error state, alert)) - barrel filled by that unit only. */
export { Badge, type BadgeProps, type BadgeTone, type BadgeSize } from './badge.js';
export { StatusDot, type StatusDotProps, type StatusDotTone } from './status-dot.js';
export { Avatar, type AvatarProps, type AvatarSize, type AvatarShape } from './avatar.js';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardBody,
  CardFooter,
  type CardProps,
  type CardHeaderProps,
  type CardTitleProps,
  type CardDescriptionProps,
  type CardBodyProps,
  type CardFooterProps,
  type CardPadding,
} from './card.js';
export {
  KpiStat,
  type KpiStatProps,
  type KpiStatDelta,
  type KpiStatDeltaDirection,
} from './kpi-stat.js';
export {
  Skeleton,
  SkeletonText,
  SkeletonRows,
  type SkeletonProps,
  type SkeletonTextProps,
  type SkeletonRowsProps,
} from './skeleton.js';
export { EmptyState, type EmptyStateProps } from './empty-state.js';
export { ErrorState, type ErrorStateProps } from './error-state.js';
export { Spinner, type SpinnerProps, type SpinnerSize } from './spinner.js';
export { Separator, type SeparatorProps, type SeparatorOrientation } from './separator.js';
export { Alert, type AlertProps, type AlertTone } from './alert.js';
