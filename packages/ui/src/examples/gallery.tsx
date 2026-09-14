import * as React from 'react';
import { cx } from '../lib/cx.js';
import { coreExamples } from './core.examples.js';
import { overlayExamples } from './overlay.examples.js';
import { chartsExamples } from './charts.examples.js';
import type { UiExample } from './types.js';

/**
 * Gallery (P26b) - renders every registered `UiExample` grouped by section.
 * Presentational: mounted only by the dev-only `/dev/gallery` route in
 * app/frontend, which owns the theme toggle; never shipped to tenants.
 */
export interface GalleryProps extends React.HTMLAttributes<HTMLDivElement> {
  examples?: readonly UiExample[];
}

export function Gallery({ examples, className, ...rest }: GalleryProps): React.JSX.Element {
  const all = examples ?? [...coreExamples, ...overlayExamples, ...chartsExamples];
  const groups = new Map<string, UiExample[]>();
  for (const example of all) {
    const list = groups.get(example.group) ?? [];
    list.push(example);
    groups.set(example.group, list);
  }
  return (
    <div className={cx('flex flex-col gap-10 font-ui text-fg', className)} {...rest}>
      {[...groups.entries()].map(([group, items]) => (
        <section key={group} className="flex flex-col gap-4" aria-label={group}>
          <h2 className="text-lg font-semibold">{group}</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((example) => (
              <article
                key={example.name}
                className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5"
              >
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                  {example.name}
                </h3>
                <div className="flex flex-col gap-3">{example.render()}</div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
