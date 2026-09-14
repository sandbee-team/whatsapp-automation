import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle, Phone, SendHorizonal, Wallet } from 'lucide-react';
import { Badge, Card, CardBody, CardHeader, CardTitle, ProgressRing, Stagger, useT } from '@wp/ui';

/**
 * GettingStartedChecklist (P26b U3; 2026-09-08 panel refresh: restyled as a
 * hero card per spec section 5.3) - the dashboard's onboarding-continuation
 * card, shown until a number is linked (the backend never advances
 * `send_test`/`done` today - a carried open item, not something the UI
 * fakes; see the design brief's onboarding-gate note). Steps are derived
 * facts, never independently-tracked booleans: "connect a number" reads
 * `hasLinkedInstance`, "send your first message" reads `hasSentMessage`,
 * "add funds" reads `hasWalletFunds` - each row links to the surface that
 * completes it. Left = a `ProgressRing` of done/total; right = three step
 * tiles in a `Stagger`. Every existing `data-testid` is unchanged.
 */
export interface ChecklistStep {
  titleKey: 'connect' | 'sendTest' | 'addFunds';
  done: boolean;
  to: string;
  icon: React.ReactNode;
}

export interface GettingStartedChecklistProps {
  hasLinkedInstance: boolean;
  hasSentMessage: boolean;
  hasWalletFunds: boolean;
}

export function GettingStartedChecklist({
  hasLinkedInstance,
  hasSentMessage,
  hasWalletFunds,
}: GettingStartedChecklistProps): React.JSX.Element {
  const t = useT();

  const steps: ChecklistStep[] = [
    {
      titleKey: 'connect',
      done: hasLinkedInstance,
      to: '/instances',
      icon: <Phone aria-hidden="true" size={16} />,
    },
    {
      titleKey: 'sendTest',
      done: hasSentMessage,
      to: '/instances',
      icon: <SendHorizonal aria-hidden="true" size={16} />,
    },
    {
      titleKey: 'addFunds',
      done: hasWalletFunds,
      to: '/wallet',
      icon: <Wallet aria-hidden="true" size={16} />,
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <Card data-testid="getting-started-checklist" padding="none" className="p-6">
      <CardHeader>
        <CardTitle>{t('dashboard.checklist.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <div className="flex items-center justify-center lg:justify-start">
            <ProgressRing
              value={(doneCount / steps.length) * 100}
              size="md"
              label={`${String(doneCount)}/${String(steps.length)}`}
            >
              <span className="text-lg font-semibold tabular-nums text-fg">
                {doneCount}/{steps.length}
              </span>
            </ProgressRing>
          </div>
          <Stagger className="grid gap-3 sm:grid-cols-3">
            {steps.map((step) => (
              <div
                key={step.titleKey}
                data-testid={`checklist-step-${step.titleKey}`}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent"
                >
                  {step.icon}
                </span>
                <span className="text-sm font-medium font-ui text-fg">
                  {t(`dashboard.checklist.${step.titleKey}.title`)}
                </span>
                <span className="text-xs font-ui text-muted">
                  {t(`dashboard.checklist.${step.titleKey}.body`)}
                </span>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Badge
                    tone={step.done ? 'success' : 'neutral'}
                    icon={
                      step.done ? (
                        <CheckCircle2 aria-hidden="true" size={12} />
                      ) : (
                        <Circle aria-hidden="true" size={12} />
                      )
                    }
                  >
                    {step.done ? t('dashboard.checklist.done') : t('dashboard.checklist.todo')}
                  </Badge>
                  {!step.done ? (
                    <Link
                      to={step.to as never}
                      data-testid={`checklist-step-${step.titleKey}-cta`}
                      className="text-sm font-ui text-accent underline underline-offset-2"
                    >
                      {t(`dashboard.checklist.${step.titleKey}.cta`)}
                    </Link>
                  ) : null}
                </div>
              </div>
            ))}
          </Stagger>
        </div>
      </CardBody>
    </Card>
  );
}
