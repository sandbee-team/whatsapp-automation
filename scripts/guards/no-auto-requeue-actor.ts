/**
 * no-auto-requeue-actor.ts (P12 Unit U5, step 8) - the "inside a function
 * that takes an actor" half of `check-no-auto-requeue.ts`, split out for
 * max-lines discipline. A TEXT heuristic, not a real AST walk: it finds
 * EVERY function-like head that is still "open" (its own closing `}` has
 * not yet been reached) at `matchIndex` - i.e. the whole chain of enclosing
 * functions, not just the nearest one - and passes if ANY of them declares
 * a parameter named `actor`. The nearest-only check was tried first and
 * rejected: this repo's real shape nests the transition inside an inner
 * `async (tx) => { ... }` callback (`deps.tenantDb.withTenant(clientId,
 * async (tx) => { ... UPDATE ... })`), whose OWN parameter list is `(tx)` -
 * only the OUTER `retryUnresolved(deps, input)` function actually declares
 * `actor` (via `input.actor`/a local `const actor = input.actor`). "Inside
 * a function that takes an actor" therefore means ANYWHERE in that
 * function's body, including nested closures, matching how a human reading
 * "the retry/discard function" would describe it.
 *
 * HONEST LIMITS (stated here, not overclaimed): this is a best-effort
 * brace-depth + keyword scan, not a real parser. It can be fooled by, at
 * minimum: (a) a function whose actor parameter is destructured under a
 * different top-level name (e.g. `{ actor: caller }`) - the identifier
 * `actor` must appear literally in SOME enclosing parameter list; (b) a
 * brace inside a string/regex literal that this scan's naive depth counter
 * miscounts (mitigated by running against comment-stripped, but not
 * string-literal-stripped, text - accepted because the real target file
 * has no such literal braces near its transition sites). Given the guard's
 * job is catching an ACCIDENTAL second requeue path (not an adversarial
 * bypass), this text heuristic naming the exact convention this codebase
 * already uses (`actor: UnresolvedActor`, `unresolved.service.ts`) is
 * proportionate; a real AST walk would be justified if this guard ever
 * needs to resist deliberate evasion, out of scope for a fail-safe/
 * invariant guard whose exempt path is a single named file.
 */

interface OpenFunctionFrame {
  paramsText: string;
  /** Brace depth this frame's body opened at - popped when depth returns to this value. */
  bodyDepth: number;
}

const FUNCTION_HEAD_PATTERN =
  /\bfunction\s+\w*\s*\(([^()]*)\)|\basync\s+function\s*\(([^()]*)\)|\(([^()]*)\)\s*(?::\s*[^=]*)?=>|\basync\s*\(([^()]*)\)\s*=>/g;

/**
 * Walks `content` from index 0 to `matchIndex`, tracking `{`/`}` brace
 * depth. Whenever a function head is matched, its parameter text is
 * queued; the NEXT `{` seen opens that function's body frame at the
 * resulting depth. A frame pops when depth returns to the value it opened
 * at. Returns true iff ANY frame still open at `matchIndex` declares
 * `actor` as a bare word in its parameter text.
 */
export function nearestEnclosingFunctionTakesActor(content: string, matchIndex: number): boolean {
  const headPattern = new RegExp(FUNCTION_HEAD_PATTERN.source, FUNCTION_HEAD_PATTERN.flags);
  const pendingParams: string[] = [];
  const openFrames: OpenFunctionFrame[] = [];
  let depth = 0;
  let nextHead = headPattern.exec(content);

  for (let i = 0; i < matchIndex; i += 1) {
    while (nextHead && nextHead.index === i) {
      pendingParams.push(nextHead[1] ?? nextHead[2] ?? nextHead[3] ?? nextHead[4] ?? '');
      nextHead = headPattern.exec(content);
    }

    const ch = content[i];
    if (ch === '{') {
      depth += 1;
      const paramsText = pendingParams.shift();
      if (paramsText !== undefined) {
        openFrames.push({ paramsText, bodyDepth: depth });
      }
    } else if (ch === '}') {
      const last = openFrames[openFrames.length - 1];
      if (last && last.bodyDepth === depth) {
        openFrames.pop();
      }
      depth -= 1;
    }
  }

  return openFrames.some((frame) => /\bactor\b/.test(frame.paramsText));
}
