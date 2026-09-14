import * as React from 'react';
import { ShieldCheck, Gauge, Users } from 'lucide-react';
import { Reveal, Stagger, useT } from '@wp/ui';
import { BrandMark } from './brand/brand-mark.js';

/**
 * AuthLayoutBrandPanel (panel-refresh spec section 6) - the left aurora panel
 * split out of `auth-layout.tsx` to stay under the 300-line cap. Two blurred
 * blobs drift via `animate-aurora` (`motion-reduce:animate-none`, the product
 * exception alongside the live-dot pulse - spec rule 5), a faint dot grid
 * sits behind a centred stack of tagline + three honest bullet tiles. Each
 * tile floats (`animate-float`) and is wrapped by `Stagger` for a staggered
 * mount-in; bullet copy stays byte-identical to the pre-refresh version (an
 * existing test asserts the exact text).
 */
export function AuthLayoutBrandPanel(): React.JSX.Element {
  const t = useT();

  const bullets = [
    { Icon: ShieldCheck, text: t('shell.authLayout.bulletDurable') },
    { Icon: Gauge, text: t('shell.authLayout.bulletHealth') },
    { Icon: Users, text: t('shell.authLayout.bulletTenant') },
  ];

  return (
    <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex">
      <div
        aria-hidden="true"
        className="absolute -left-16 -top-16 h-72 w-72 rounded-full bg-accent/20 blur-3xl animate-aurora motion-reduce:animate-none"
      />
      <div
        aria-hidden="true"
        className="absolute -bottom-24 -right-10 h-80 w-80 rounded-full bg-info/10 blur-3xl animate-aurora motion-reduce:animate-none"
        style={{ animationDelay: '-4s' }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
      />

      <div className="relative">
        <BrandMark size="lg" variant="auth" />
      </div>

      <div className="relative flex flex-col gap-6">
        <p className="max-w-sm text-3xl font-semibold font-ui tracking-tight text-fg">
          {t('shell.authLayout.tagline')}
        </p>
        <Stagger stepMs={120} className="flex flex-col gap-4">
          {bullets.map(({ Icon, text }, index) => (
            <div
              key={text}
              className={`flex items-start gap-3 rounded-xl border border-border/60 bg-surface/70 p-4 shadow-card backdrop-blur animate-float motion-reduce:animate-none ${
                index === 1 ? 'lg:translate-x-6' : ''
              }`}
              style={{ animationDelay: `${String(index * 400)}ms` }}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon aria-hidden size={18} strokeWidth={1.75} />
              </span>
              <span className="text-sm text-sidebar-muted">{text}</span>
            </div>
          ))}
        </Stagger>
      </div>

      <Reveal as="span" variant="fade" className="relative text-xs text-sidebar-muted">
        {t('onboarding.authLayout.footerLine')}
      </Reveal>
    </div>
  );
}
