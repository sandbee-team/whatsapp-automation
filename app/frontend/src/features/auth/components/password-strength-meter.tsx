import * as React from 'react';
import { cx, useT } from '@wp/ui';
import type { MessageKey } from '@wp/i18n';
import { passwordStrength, type PasswordStrengthLabel } from './password-strength.js';

/**
 * PasswordStrengthMeter (P26b U2) - 4 segments driven by the pure
 * `passwordStrength` function. Never colour-only: the label text (Weak /
 * Fair / Good / Strong) always renders alongside the segment fill.
 */
const SEGMENT_TONE_CLASSES: Record<number, string> = {
  0: 'bg-danger',
  1: 'bg-danger',
  2: 'bg-warning',
  3: 'bg-accent',
  4: 'bg-success',
};

const LABEL_KEY: Record<PasswordStrengthLabel, MessageKey> = {
  weak: 'shell.auth.passwordStrength.weak',
  fair: 'shell.auth.passwordStrength.fair',
  good: 'shell.auth.passwordStrength.good',
  strong: 'shell.auth.passwordStrength.strong',
};

export function PasswordStrengthMeter({ password }: { password: string }): React.JSX.Element {
  const t = useT();
  const { score, label } = passwordStrength(password);
  const toneClass = SEGMENT_TONE_CLASSES[score] ?? 'bg-danger';

  return (
    <div className="flex flex-col gap-1" aria-hidden={password.length === 0}>
      <div className="flex gap-1" role="presentation">
        {[0, 1, 2, 3].map((segmentIndex) => (
          <span
            key={segmentIndex}
            className={cx(
              'h-1 flex-1 rounded-full',
              segmentIndex < score ? toneClass : 'bg-surface-3',
            )}
          />
        ))}
      </div>
      {password.length > 0 ? (
        <p className="text-xs text-muted">
          {t('shell.auth.passwordStrength')}: {t(LABEL_KEY[label])}
        </p>
      ) : null}
    </div>
  );
}
