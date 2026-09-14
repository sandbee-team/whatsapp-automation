import { describe, expect, it } from 'vitest';
import { dekWrapAad, recordAad } from './aad.js';

describe('AAD length-prefix encoding - no separator-collision ambiguity', () => {
  it('recordAad_ab_c_never_collides_with_a_bc_across_the_field_boundary', () => {
    // A naive `join('|')` AAD would collide: "ab|c" === "a" + "b" + "|" + "c"
    // joined the same way as "a|bc". The length-prefixed encoding must keep
    // these distinct because the byte length precedes each field.
    const left = recordAad({
      encVersion: 1,
      tableName: 'ab',
      columnName: 'c',
      clientId: 'x',
      recordId: 'y',
    });
    const right = recordAad({
      encVersion: 1,
      tableName: 'a',
      columnName: 'bc',
      clientId: 'x',
      recordId: 'y',
    });
    expect(left.equals(right)).toBe(false);
  });

  it('recordAad_clientId_ab_c_never_collides_with_a_bc_across_the_field_boundary', () => {
    const left = recordAad({
      encVersion: 1,
      tableName: 't',
      columnName: 'col',
      clientId: 'ab',
      recordId: 'c',
    });
    const right = recordAad({
      encVersion: 1,
      tableName: 't',
      columnName: 'col',
      clientId: 'a',
      recordId: 'bc',
    });
    expect(left.equals(right)).toBe(false);
  });

  it('dekWrapAad_kekId_ab_purpose_session_never_collides_with_kekId_a_and_a_different_split', () => {
    // encVersion is numeric ("1"/"12"), kekId and purpose are the only
    // string fields here - prove the same cross-field ambiguity is absent.
    const left = dekWrapAad({ encVersion: 1, kekId: '12', purpose: 'session' });
    const right = dekWrapAad({
      encVersion: 12,
      kekId: '1',
      purpose: 'session',
    });
    // Even though the concatenated digits "1"+"12" vs "12"+"1" look similar,
    // each field carries its own length prefix, so encVersion=1/kekId="12"
    // must differ from encVersion=12/kekId="1".
    expect(left.equals(right)).toBe(false);
  });

  it('unicode_field_values_round_trip_into_distinct_AAD_bytes', () => {
    const a = recordAad({
      encVersion: 1,
      tableName: 't',
      columnName: 'c',
      clientId: '\u{1F600}tenant',
      recordId: 'rec-1',
    });
    const b = recordAad({
      encVersion: 1,
      tableName: 't',
      columnName: 'c',
      clientId: 'tenant',
      recordId: 'rec-1',
    });
    expect(a.equals(b)).toBe(false);
    // Same unicode input produces the same bytes deterministically.
    const aAgain = recordAad({
      encVersion: 1,
      tableName: 't',
      columnName: 'c',
      clientId: '\u{1F600}tenant',
      recordId: 'rec-1',
    });
    expect(a.equals(aAgain)).toBe(true);
  });

  it('empty_string_fields_produce_a_zero_length_prefix_not_a_shifted_encoding', () => {
    const withEmpty = recordAad({
      encVersion: 1,
      tableName: 't',
      columnName: 'c',
      clientId: '',
      recordId: 'rec-1',
    });
    const withoutEmpty = recordAad({
      encVersion: 1,
      tableName: 't',
      columnName: 'c',
      clientId: 'rec-1',
      recordId: '',
    });
    // clientId='' + recordId='rec-1' must differ from clientId='rec-1' +
    // recordId='' - the length-prefix for the empty field is 0x00000000,
    // not simply "absent".
    expect(withEmpty.equals(withoutEmpty)).toBe(false);
  });
});
