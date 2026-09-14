/**
 * resume-support.ts (P16 Unit D, step 8) - typed errors `resume.ts` and
 * `resume.routes.ts` share, split out for max-lines discipline (same idiom
 * as `instances.routes-support.ts`'s own error classes). Not a public module
 * surface - `resume.ts`/`resume.routes.ts` are the only importers.
 */

export class InstanceNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such WhatsApp instance.');
    this.name = 'InstanceNotFoundError';
  }
}

export class InvalidStateError extends Error {
  readonly code = 'INVALID_STATE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

/** 403 - see resume.ts's own module doc for the full actor-guard rationale. */
export class ResumeRequiresUserError extends Error {
  readonly code = 'RESUME_REQUIRES_USER';
  constructor() {
    super('Resuming a paused instance requires a signed-in user.');
    this.name = 'ResumeRequiresUserError';
  }
}

/** 422 - a restriction-pause resume attempt without the required acknowledgement flag. */
export class AcknowledgementRequiredError extends Error {
  readonly code = 'ACKNOWLEDGEMENT_REQUIRED';
  constructor() {
    super('Resuming this instance requires explicit acknowledgement.');
    this.name = 'AcknowledgementRequiredError';
  }
}

/**
 * WARNING 7 fix (P16 fix round) - redacts any run of 10+ consecutive digits
 * (phone-number-shaped, matching the evidence path's own no-PII discipline)
 * from a free-text field before it enters `audit_logs.metadata`. `null`
 * passes through unchanged.
 */
export function redactLongDigitRuns(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.replace(/\d{10,}/g, '[redacted]');
}
