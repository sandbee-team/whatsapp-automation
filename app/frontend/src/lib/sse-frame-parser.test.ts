import { describe, expect, it } from 'vitest';
import { createSseFrameParser, type ParsedSseFrame } from './sse-frame-parser.js';

/**
 * lib/sse-frame-parser.test.ts (test-engineer hardening pass) - the
 * incremental parser must never throw or mis-frame regardless of how the
 * underlying `fetch` stream happens to chunk bytes: splits inside a field
 * name or value, CRLF vs LF, multi-line `data:`, comment-only keepalives,
 * fields missing `id`/`event`, and pathologically large lines.
 */

function collect(pushes: string[]): ParsedSseFrame[] {
  const frames: ParsedSseFrame[] = [];
  const parser = createSseFrameParser((frame) => frames.push(frame));
  for (const chunk of pushes) {
    parser.push(chunk);
  }
  return frames;
}

describe('createSseFrameParser', () => {
  it('a_frame_split_across_arbitrary_chunk_boundaries_inside_the_data_field_name_still_parses', () => {
    const full = 'id: 1\nevent: instance.qr\ndata: {"a":1}\n\n';
    // Split right inside the word "data".
    const splitPoint = full.indexOf('data: ') + 2;
    const frames = collect([full.slice(0, splitPoint), full.slice(splitPoint)]);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: '1', event: 'instance.qr', data: '{"a":1}' });
  });

  it('a_frame_split_in_the_middle_of_the_data_value_still_parses', () => {
    const full = 'id: 1\nevent: instance.qr\ndata: {"a":12345}\n\n';
    const splitPoint = full.indexOf('12345') + 2;
    const frames = collect([full.slice(0, splitPoint), full.slice(splitPoint)]);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('{"a":12345}');
  });

  it('a_frame_split_one_byte_at_a_time_still_parses_correctly', () => {
    const full = 'id: 7\nevent: campaign.progress\ndata: {"sent":1}\n\n';
    const frames = collect(full.split(''));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: '7', event: 'campaign.progress', data: '{"sent":1}' });
  });

  it('crlf_line_endings_parse_identically_to_lf', () => {
    const full = 'id: 1\r\nevent: instance.qr\r\ndata: {"a":1}\r\n\r\n';
    const frames = collect([full]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: '1', event: 'instance.qr', data: '{"a":1}' });
  });

  it('mixed_crlf_and_lf_within_the_same_stream_both_terminate_lines', () => {
    const chunk = 'id: 1\r\nevent: a\ndata: x\r\n\n';
    const frames = collect([chunk]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: '1', event: 'a', data: 'x' });
  });

  it('a_multi_line_data_field_joins_with_newlines_in_order', () => {
    const full = 'id: 1\nevent: a\ndata: line1\ndata: line2\ndata: line3\n\n';
    const frames = collect([full]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('line1\nline2\nline3');
  });

  it('comment_only_keepalive_lines_never_emit_a_frame_and_do_not_reset_in_progress_fields', () => {
    const frames = collect(['id: 1\nevent: a\n: hb\ndata: x\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: '1', event: 'a', data: 'x' });
  });

  it('a_pure_comment_frame_with_a_trailing_blank_line_emits_nothing', () => {
    const frames = collect([': hb\n\n']);
    expect(frames).toHaveLength(0);
  });

  it('an_event_with_no_id_field_still_parses_with_id_undefined', () => {
    const frames = collect(['event: a\ndata: x\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: undefined, event: 'a', data: 'x' });
  });

  it('an_id_with_no_event_field_still_parses_with_event_undefined', () => {
    const frames = collect(['id: 42\ndata: x\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: '42', event: undefined, data: 'x' });
  });

  it('a_data_only_frame_with_neither_id_nor_event_still_emits', () => {
    const frames = collect(['data: only-data\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: undefined, event: undefined, data: 'only-data' });
  });

  it('a_blank_line_with_no_preceding_fields_emits_nothing_and_does_not_throw', () => {
    expect(() => collect(['\n\n\n'])).not.toThrow();
    expect(collect(['\n\n\n'])).toHaveLength(0);
  });

  it('a_16kb_data_line_parses_without_truncation_or_throwing', () => {
    const bigValue = 'x'.repeat(16 * 1024);
    const full = `id: 1\nevent: a\ndata: ${bigValue}\n\n`;
    const frames = collect([full]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toHaveLength(bigValue.length);
    expect(frames[0]!.data).toBe(bigValue);
  });

  it('a_16kb_data_line_split_across_many_small_chunks_still_parses_correctly', () => {
    const bigValue = 'y'.repeat(16 * 1024);
    const full = `id: 1\nevent: a\ndata: ${bigValue}\n\n`;
    const chunkSize = 37; // deliberately not aligned with any field boundary
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += chunkSize) {
      chunks.push(full.slice(i, i + chunkSize));
    }
    const frames = collect(chunks);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe(bigValue);
  });

  it('a_field_value_containing_a_colon_keeps_everything_after_the_first_colon', () => {
    const frames = collect(['data: {"a":"b:c"}\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('{"a":"b:c"}');
  });

  it('a_field_with_no_colon_at_all_is_treated_as_the_field_name_with_an_empty_value', () => {
    // Per the SSE spec, a line with no colon is the field name with value "".
    const frames = collect(['event\ndata: x\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: undefined, event: '', data: 'x' });
  });

  it('multiple_frames_back_to_back_in_one_chunk_are_all_emitted_in_order', () => {
    const full = 'id: 1\nevent: a\ndata: x\n\nid: 2\nevent: b\ndata: y\n\n';
    const frames = collect([full]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ id: '1', event: 'a', data: 'x' });
    expect(frames[1]).toEqual({ id: '2', event: 'b', data: 'y' });
  });

  it('an_unterminated_trailing_partial_frame_is_buffered_and_not_emitted_until_completed', () => {
    const parser = createSseFrameParser(() => {
      throw new Error('must not emit before the terminating blank line arrives');
    });
    expect(() => parser.push('id: 1\nevent: a\ndata: x')).not.toThrow();
  });
});
