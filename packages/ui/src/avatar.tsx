'use client';

import * as React from 'react';
import { Avatar as BaseAvatar } from '@base-ui/react/avatar';
import { cx } from './lib/cx.js';

/**
 * Avatar - Base UI Avatar (Root/Image/Fallback) with an initials fallback
 * derived from `name`. Carries `'use client'`: Base UI's Avatar tracks image
 * loading status via internal state/effects.
 */
export type AvatarSize = 'sm' | 'md' | 'lg';
export type AvatarShape = 'circle' | 'square';

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string;
  /** Full display name - source of both the accessible label and the initials fallback. */
  name: string;
  size?: AvatarSize;
  shape?: AvatarShape;
}

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
};

const SHAPE_CLASSES: Record<AvatarShape, string> = {
  circle: 'rounded-full',
  square: 'rounded-md',
};

/** Token-class-only tint list (chart-1..5 soft backgrounds - no colour literals). */
const TINT_CLASSES = [
  'bg-chart-1/20 text-chart-1',
  'bg-chart-2/20 text-chart-2',
  'bg-chart-3/20 text-chart-3',
  'bg-chart-4/20 text-chart-4',
  'bg-chart-5/20 text-chart-5',
];

/** Devanagari-safe: iterates Unicode code points via `Array.from`, never
 * UTF-16 code units, so a combining vowel sign is never split from its base
 * consonant. Takes the first code point of up to the first two words. */
function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const picked = words.slice(0, 2);
  return picked
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
}

function tintClassForName(name: string): string {
  let hash = 0;
  for (const codePoint of Array.from(name)) {
    hash = (hash * 31 + codePoint.codePointAt(0)!) >>> 0;
  }
  return TINT_CLASSES[hash % TINT_CLASSES.length]!;
}

export const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { src, name, size = 'md', shape = 'circle', className, ...rest },
  ref,
) {
  const initials = initialsFromName(name);
  const tintClass = tintClassForName(name);

  return (
    <BaseAvatar.Root
      ref={ref}
      role="img"
      aria-label={name}
      className={cx(
        'inline-flex select-none items-center justify-center overflow-hidden font-medium font-ui',
        SIZE_CLASSES[size],
        SHAPE_CLASSES[shape],
        className,
      )}
      {...rest}
    >
      {src ? <BaseAvatar.Image src={src} alt="" className="h-full w-full object-cover" /> : null}
      <BaseAvatar.Fallback
        data-testid="avatar-fallback"
        className={cx('flex h-full w-full items-center justify-center', tintClass)}
      >
        {initials}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
});
