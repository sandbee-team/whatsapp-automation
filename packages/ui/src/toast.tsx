'use client';

import * as React from 'react';
import { CircleCheck, TriangleAlert, CircleX, Info, X, type LucideIcon } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * ToastProvider + useToast() - a `role="status"` `aria-live="polite"` region
 * that renders active toasts (bottom-right stack) and auto-dismisses them
 * after `duration` ms. The dismiss timer is injectable (`setTimeout`/
 * `clearTimeout` pair, default the real globals) so tests can use fake
 * clocks deterministically (test-discipline: no sleeps, no real-clock
 * flakiness). At most `maxVisible` toasts show at once; older ones queue.
 * Carries `'use client'`: uses `useState`/`useEffect`.
 */
export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. Defaults to 5000. */
  duration?: number;
}

export interface ToastRecord extends ToastInput {
  id: string;
}

export interface ToastTimerApi {
  setTimeout: (callback: () => void, ms: number) => number | ReturnType<typeof setTimeout>;
  clearTimeout: (handle: number | ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_TIMER_API: ToastTimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const DEFAULT_DURATION_MS = 5000;
const DEFAULT_MAX_VISIBLE = 4;

export interface ToastContextValue {
  toasts: ToastRecord[];
  showToast: (toast: ToastInput) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | undefined>(undefined);

export interface ToastProviderProps {
  children: React.ReactNode;
  /** Injectable timer, defaults to the real `setTimeout`/`clearTimeout`. */
  timerApi?: ToastTimerApi;
  /**
   * Accessible label for each toast's dismiss button. When omitted, the
   * dismiss button is not rendered (an unlabelled icon button would fail
   * accessibility) and toasts rely on auto-dismiss only.
   */
  dismissLabel?: string;
  /** Maximum toasts visible at once; older ones queue. @default 4 */
  maxVisible?: number;
}

const TONE_ICONS: Record<ToastTone, LucideIcon> = {
  neutral: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
  info: Info,
};

const TONE_ICON_CLASSES: Record<ToastTone, string> = {
  neutral: 'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

let toastIdCounter = 0;

export function ToastProvider({
  children,
  timerApi = DEFAULT_TIMER_API,
  dismissLabel,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: ToastProviderProps): React.JSX.Element {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const timersRef = React.useRef(new Map<string, number | ReturnType<typeof setTimeout>>());

  const dismissToast = React.useCallback(
    (id: string) => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      const handle = timersRef.current.get(id);
      if (handle !== undefined) {
        timerApi.clearTimeout(handle);
        timersRef.current.delete(id);
      }
    },
    [timerApi],
  );

  const showToast = React.useCallback(
    (toast: ToastInput): string => {
      toastIdCounter += 1;
      const id = `toast-${String(toastIdCounter)}`;
      const record: ToastRecord = { id, ...toast };
      setToasts((current) => [...current, record]);
      const duration = toast.duration ?? DEFAULT_DURATION_MS;
      const handle = timerApi.setTimeout(() => {
        dismissToast(id);
      }, duration);
      timersRef.current.set(id, handle);
      return id;
    },
    [timerApi, dismissToast],
  );

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) {
        timerApi.clearTimeout(handle);
      }
      timers.clear();
    };
  }, [timerApi]);

  const value = React.useMemo<ToastContextValue>(
    () => ({ toasts, showToast, dismissToast }),
    [toasts, showToast, dismissToast],
  );

  const visibleToasts = toasts.slice(0, maxVisible);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {visibleToasts.map((toast) => (
          <ToastCard
            key={toast.id}
            toast={toast}
            dismissLabel={dismissLabel}
            onDismiss={dismissToast}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({
  toast,
  dismissLabel,
  onDismiss,
}: {
  toast: ToastRecord;
  dismissLabel?: string;
  onDismiss: (id: string) => void;
}): React.JSX.Element {
  const tone = toast.tone ?? 'neutral';
  const ToneIcon = TONE_ICONS[tone];

  return (
    <div
      className={cx(
        'pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-surface p-3 shadow-lg',
        'font-ui text-fg transition-[opacity,transform] duration-200',
        'data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0',
        'data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0',
      )}
    >
      <ToneIcon aria-hidden size={18} className={cx('mt-0.5 shrink-0', TONE_ICON_CLASSES[tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 text-sm text-muted">{toast.description}</p>
        ) : null}
      </div>
      {dismissLabel ? (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={() => onDismiss(toast.id)}
          className={cx(
            'shrink-0 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <X aria-hidden size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return context;
}
