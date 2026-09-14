import * as React from 'react';
import { Reveal } from '@wp/ui';
import { AuthLayoutBrandPanel } from './auth-layout-brand-panel.js';
import { BrandMark } from './brand/brand-mark.js';

/**
 * AuthLayout (panel-refresh spec section 6) - the split-screen auth chrome: a
 * left aurora brand panel (`AuthLayoutBrandPanel`, hidden below `lg`) and a
 * right form card wrapped in a `pop` `Reveal`. Copy for the brand panel comes
 * from `@wp/i18n` (`shell.authLayout.*` + `onboarding.authLayout.*`) and is
 * deliberately honest - three value bullets about durability/health/
 * multi-tenant control, never a delivery-speed or restriction-avoidance claim
 * (safety-compliance rule).
 */
export interface AuthLayoutProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  aside?: React.ReactNode;
}

export function AuthLayout({
  title,
  description,
  children,
  footer,
  aside,
}: AuthLayoutProps): React.JSX.Element {
  return (
    <div className="flex min-h-screen bg-bg text-fg">
      <AuthLayoutBrandPanel />

      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="mb-6 lg:hidden">
          <BrandMark size="md" variant="auth" />
        </div>

        <Reveal
          variant="pop"
          className="w-full max-w-md rounded-2xl border border-border/70 bg-surface p-8 shadow-elevated"
        >
          <div className="mb-6 flex flex-col gap-1">
            <h1 className="text-2xl font-semibold font-ui tracking-tight text-fg">{title}</h1>
            {description ? <p className="text-sm font-ui text-muted">{description}</p> : null}
          </div>
          {children}
          {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
        </Reveal>
        {aside ? <Reveal delayMs={120}>{aside}</Reveal> : null}
      </div>
    </div>
  );
}
