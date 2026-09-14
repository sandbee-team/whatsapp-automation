import type * as React from 'react';

/** One gallery card: a primitive rendered in a representative state (dev-only `/dev/gallery`). */
export interface UiExample {
  /** Display name, e.g. "Button / variants". */
  name: string;
  /** Section the card sorts under, e.g. "Forms", "Overlays", "Data". */
  group: string;
  render: () => React.JSX.Element;
}
