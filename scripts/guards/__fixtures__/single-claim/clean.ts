// Fixture: legitimate code that mentions 'processing' and issues an
// unrelated UPDATE, but never sets status='processing' - must stay clean.
export function isProcessing(status: string): boolean {
  return status === 'processing';
}

export function bumpFence(): string {
  return 'UPDATE instance_lease_state SET current_fence = current_fence + 1 WHERE instance_id = $1';
}

// A parameterized UPDATE on message_jobs that never touches status - proves
// PARAMETERIZED_STATUS_PATTERN doesn't false-positive on an unrelated column.
export function bumpAttempts(): string {
  return 'UPDATE message_jobs SET attempts = $1 WHERE id = $2';
}
