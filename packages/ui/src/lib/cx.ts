/**
 * Tiny class-name joiner: filters falsy values, joins the rest with a single
 * space. Deliberately not `clsx` (design doc: "no new runtime deps beyond
 * Base UI and React") - the workspace's Tailwind class strings never need
 * conditional-object syntax, only a falsy-filtering join.
 */
export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  return values.filter((value): value is string => Boolean(value)).join(' ');
}
