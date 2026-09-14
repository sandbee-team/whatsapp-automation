'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Table / THead / TBody / TR / TH / TD - carries `'use client'` because `TR`
 * reads row styling from context (`useContext`). `Table`'s `caption` prop
 * renders a real `<caption>` element
 * element (required for accessible tables, not just a visual label). `TH`
 * always sets `scope="col"` per the header-cell convention this design
 * system uses (row headers are out of scope for v1). `dense`/`zebra` are set
 * on `Table` and read by `TR` via context so row styling stays centralised;
 * `TableContainer` wraps the table in the bordered, horizontally-scrollable
 * frame the layout system expects (design brief section 3: tables never
 * scroll the page body horizontally).
 */
interface TableRowStyleContextValue {
  dense: boolean;
  zebra: boolean;
}

const TableRowStyleContext = React.createContext<TableRowStyleContextValue>({
  dense: false,
  zebra: false,
});

export type TableContainerProps = React.HTMLAttributes<HTMLDivElement>;

export function TableContainer({ className, ...rest }: TableContainerProps): React.JSX.Element {
  return (
    <div className={cx('overflow-x-auto rounded-lg border border-border', className)} {...rest} />
  );
}

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  caption: string;
  /** Compact row height (`h-9` instead of the default `h-11`). */
  dense?: boolean;
  /** Alternate row background tint on even body rows. */
  zebra?: boolean;
}

export function Table({
  caption,
  dense = false,
  zebra = false,
  className,
  children,
  ...rest
}: TableProps): React.JSX.Element {
  const rowStyle = React.useMemo<TableRowStyleContextValue>(
    () => ({ dense, zebra }),
    [dense, zebra],
  );
  return (
    <TableRowStyleContext.Provider value={rowStyle}>
      <table className={cx('w-full border-collapse text-sm font-ui text-fg', className)} {...rest}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </TableRowStyleContext.Provider>
  );
}

export type THeadProps = React.HTMLAttributes<HTMLTableSectionElement>;

export function THead({ className, ...rest }: THeadProps): React.JSX.Element {
  return (
    <thead
      className={cx(
        'sticky top-0 z-10 border-b border-border bg-surface-2 text-xs uppercase tracking-wide text-muted',
        className,
      )}
      {...rest}
    />
  );
}

export type TBodyProps = React.HTMLAttributes<HTMLTableSectionElement>;

export function TBody({ className, ...rest }: TBodyProps): React.JSX.Element {
  return <tbody className={className} {...rest} />;
}

export type TRProps = React.HTMLAttributes<HTMLTableRowElement>;

export function TR({ className, ...rest }: TRProps): React.JSX.Element {
  const { dense, zebra } = React.useContext(TableRowStyleContext);
  return (
    <tr
      className={cx(
        'border-b border-border last:border-0 hover:bg-surface-2/60',
        dense ? 'h-9' : 'h-11',
        zebra && 'even:bg-surface-2/40',
        className,
      )}
      {...rest}
    />
  );
}

export type THProps = React.ThHTMLAttributes<HTMLTableCellElement>;

export function TH({ className, scope = 'col', ...rest }: THProps): React.JSX.Element {
  return (
    <th scope={scope} className={cx('px-3 py-2 text-left font-medium', className)} {...rest} />
  );
}

export type TDProps = React.TdHTMLAttributes<HTMLTableCellElement>;

export function TD({ className, ...rest }: TDProps): React.JSX.Element {
  return <td className={cx('px-3 py-2', className)} {...rest} />;
}
