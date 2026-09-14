import type * as React from 'react';

/** One axe fixture for `test/a11y.test.tsx`: a primitive in a representative state. */
export interface Fixture {
  name: string;
  render: () => React.JSX.Element;
}
