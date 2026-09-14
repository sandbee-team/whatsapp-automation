/**
 * lib/sse-frame-parser.ts - the incremental SSE wire-frame parser used by
 * `lib/sse.ts` (split into its own file to stay under the workspace's
 * 300-line max-lines lint rule). Mirrors the backend's frame shape
 * (`app/backend/src/platform/http/sse.ts`'s `formatFrame`/`formatComment`)
 * from the wire side: `id:`/`event:`/`data:` fields, multi-line `data:`,
 * and `:`-prefixed comment lines (heartbeats), CRLF- and LF-tolerant.
 */

export interface ParsedSseFrame {
  id?: string;
  event?: string;
  data: string;
}

export interface SseFrameParser {
  push: (chunk: string) => void;
}

/**
 * Feed raw decoded text chunks in via `push`; emits one `ParsedSseFrame`
 * per blank-line-terminated block via `onFrame`. A `:`-prefixed comment
 * line (heartbeat) is consumed as parser state without ending or emitting
 * a frame.
 */
export function createSseFrameParser(onFrame: (frame: ParsedSseFrame) => void): SseFrameParser {
  let buffer = '';
  let id: string | undefined;
  let event: string | undefined;
  let dataLines: string[] = [];
  let sawAnyField = false;

  function resetFrame(): void {
    id = undefined;
    event = undefined;
    dataLines = [];
    sawAnyField = false;
  }

  function processLine(line: string): void {
    if (line === '') {
      if (sawAnyField) {
        onFrame({ id, event, data: dataLines.join('\n') });
      }
      resetFrame();
      return;
    }
    if (line.startsWith(':')) {
      // Comment/heartbeat - not a field, does not end the frame.
      return;
    }
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    const rawValue = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'id') {
      id = value;
      sawAnyField = true;
    } else if (field === 'event') {
      event = value;
      sawAnyField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawAnyField = true;
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    },
  };
}
