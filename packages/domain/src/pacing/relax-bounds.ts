import {
  ABSOLUTE_DAILY_CEILING,
  ABSOLUTE_GAP_MIN_MS,
  ABSOLUTE_GROUP_DAILY_CEILING,
} from './constants.js';
import type { PacingLayer } from './resolve-effective.js';

/**
 * pacing/relax-bounds.ts (P28 Unit U2, step 3) - `clampAdminRelax`, the pure
 * decision that clamps a staff-submitted pacing-relax patch against the same
 * absolute constants `resolveEffective()`'s own last clamp enforces
 * (`clampToAbsolutes` in `resolve-effective.ts`), BEFORE the patch is ever
 * persisted as an `admin_override` row. This is a belt-and-braces clamp: the
 * fold in `resolveEffective()` would already refuse to let a patch exceed
 * these bounds at resolution time, but a staff mutation must never even
 * STORE an out-of-bounds override (an operator reading the stored patch
 * later must see the number that will actually apply, not an aspirational
 * one) - core invariant 6 (no provider-evasion mechanism, ever) holds
 * whether or not a later resolution step would also have caught it.
 *
 * Expiry is MANDATORY and BOUNDED: an admin relax with no expiry, or one
 * further out than `MAX_ADMIN_RELAX_MS`, is refused outright - a relax is a
 * temporary, reasoned, audited loosening, never a permanent one (design
 * §4.1, mirrored in the `AdminOverride` doc comment in `resolve-effective.ts`).
 */

export type AdminRelaxPatch = Partial<
  Pick<
    PacingLayer,
    'dailyCap' | 'hourlyCap' | 'newConvCap' | 'gapMinMs' | 'gapMaxMs' | 'groupDailyCap'
  >
>;

/** The maximum distance (ms) an admin relax's `expiresAtMs` may sit ahead of `nowMs` - 30 days. */
export const MAX_ADMIN_RELAX_MS = 30 * 24 * 3600 * 1000;

export class AdminRelaxExpiryError extends Error {
  constructor(expiresAtMs: number, nowMs: number) {
    super(
      `clampAdminRelax: expiresAtMs (${expiresAtMs}) must be strictly after nowMs (${nowMs}) and ` +
        `no more than ${MAX_ADMIN_RELAX_MS}ms ahead of it`,
    );
    this.name = 'AdminRelaxExpiryError';
  }
}

export class AdminRelaxEmptyPatchError extends Error {
  constructor() {
    super('clampAdminRelax: patch must set at least one field');
    this.name = 'AdminRelaxEmptyPatchError';
  }
}

export class AdminRelaxInvalidValueError extends Error {
  readonly field: string;
  readonly value: number;

  constructor(field: string, value: number) {
    super(`clampAdminRelax: ${field} must be a positive integer, got ${value}`);
    this.name = 'AdminRelaxInvalidValueError';
    this.field = field;
    this.value = value;
  }
}

export interface ClampAdminRelaxInput {
  patch: AdminRelaxPatch;
  expiresAtMs: number;
  nowMs: number;
}

export interface ClampAdminRelaxResult {
  patch: AdminRelaxPatch;
  clampedFields: string[];
}

const CEILING_FIELDS: ReadonlyArray<[keyof AdminRelaxPatch, number]> = [
  ['dailyCap', ABSOLUTE_DAILY_CEILING],
  ['hourlyCap', ABSOLUTE_DAILY_CEILING],
  ['newConvCap', ABSOLUTE_DAILY_CEILING],
  ['groupDailyCap', ABSOLUTE_GROUP_DAILY_CEILING],
];

const FLOOR_FIELDS: ReadonlyArray<keyof AdminRelaxPatch> = ['gapMinMs', 'gapMaxMs'];

function assertValid(field: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AdminRelaxInvalidValueError(field, value);
  }
}

/**
 * Clamps `input.patch` to the absolute platform pacing bounds, and validates
 * `input.expiresAtMs` against `input.nowMs`. Every field the patch sets is
 * validated (positive integer) BEFORE any clamping runs, so an invalid input
 * never silently becomes a clamped-but-wrong value.
 */
export function clampAdminRelax(input: ClampAdminRelaxInput): ClampAdminRelaxResult {
  const { patch, expiresAtMs, nowMs } = input;

  if (Object.keys(patch).length === 0) {
    throw new AdminRelaxEmptyPatchError();
  }

  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) assertValid(field, value);
  }

  if (expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_ADMIN_RELAX_MS) {
    throw new AdminRelaxExpiryError(expiresAtMs, nowMs);
  }

  const clamped: AdminRelaxPatch = { ...patch };
  const clampedFields: string[] = [];

  for (const [field, ceiling] of CEILING_FIELDS) {
    const value = clamped[field];
    if (value !== undefined && value > ceiling) {
      clamped[field] = ceiling;
      clampedFields.push(field);
    }
  }

  for (const field of FLOOR_FIELDS) {
    const value = clamped[field];
    if (value !== undefined && value < ABSOLUTE_GAP_MIN_MS) {
      clamped[field] = ABSOLUTE_GAP_MIN_MS;
      clampedFields.push(field);
    }
  }

  if (
    clamped.gapMinMs !== undefined &&
    clamped.gapMaxMs !== undefined &&
    clamped.gapMaxMs < clamped.gapMinMs
  ) {
    clamped.gapMaxMs = clamped.gapMinMs;
    if (!clampedFields.includes('gapMaxMs')) clampedFields.push('gapMaxMs');
  }

  return { patch: clamped, clampedFields };
}
