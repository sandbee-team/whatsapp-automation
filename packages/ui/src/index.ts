/**
 * @wp/ui - React design system used by app/frontend, admin/frontend and
 * website (Button, Table, Sheet, HealthBadge, QueueDepthMeter, ...). No data
 * fetching, no router import, contracts types only (design doc §2.1;
 * dependency rule: ui -> design-tokens, i18n, utils, contracts [types only]).
 */
export const packageName = '@wp/ui' as const;

export { cx, type ClassValue } from './lib/cx.js';

export {
  I18nProvider,
  useLocale,
  useT,
  type I18nContextValue,
  type I18nProviderProps,
  type TFunction,
} from './i18n/i18n-provider.js';
export type { Locale } from '@wp/i18n';

export { Spinner, type SpinnerProps } from './spinner.js';
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './button.js';
export { Input, type InputProps } from './input.js';
export {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  CardFooter,
  type CardProps,
  type CardHeaderProps,
  type CardTitleProps,
  type CardBodyProps,
  type CardFooterProps,
} from './card.js';
export { Badge, type BadgeProps, type BadgeTone } from './badge.js';
export { Sheet, type SheetProps } from './sheet.js';
export {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  type TableProps,
  type THeadProps,
  type TBodyProps,
  type TRProps,
  type THProps,
  type TDProps,
} from './table.js';
export {
  ToastProvider,
  useToast,
  type ToastProviderProps,
  type ToastContextValue,
  type ToastInput,
  type ToastRecord,
  type ToastTone,
  type ToastTimerApi,
} from './toast.js';
export { EmptyState, type EmptyStateProps } from './empty-state.js';

// P26b design-system barrels (one per parallel unit - see each file's header).
export * from './exports-core.js';
export * from './exports-overlays.js';
export * from './exports-charts.js';
export { Gallery, type GalleryProps } from './examples/gallery.js';
export type { UiExample } from './examples/types.js';
