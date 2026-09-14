import { describe, expect, it } from 'vitest';
import {
  childExecArgv,
  DEFAULT_CHILD_EXEC_ARGV,
  InvalidChildExecArgvOverrideError,
  loaderFlagsOf,
} from './child-exec-argv.js';

describe('childExecArgv (P26 run #4 root cause: children must load TS like their parent)', () => {
  it('a_parent_started_with_an_explicit_linux_loader_passes_exactly_that_loader_to_its_children', () => {
    const parentExecArgv = [
      '--max-old-space-size=4096',
      '--import',
      '/lt/node_modules/tsx/dist/loader.mjs',
    ];
    expect(childExecArgv({ parentExecArgv })).toEqual([
      '--import',
      '/lt/node_modules/tsx/dist/loader.mjs',
    ]);
  });

  it('a_vitest_parent_with_only_a_cjs_preload_falls_back_to_the_ts_loader_default', () => {
    // vitest workers carry `--require .../vitest/suppress-warnings.cjs` - a
    // plain CJS preload that cannot execute TypeScript. Inheriting it as "the
    // parent's loader" spawned children with NO TS loader (U6c finding 1).
    const parentExecArgv = [
      '--require',
      '/repo/node_modules/.pnpm/vitest@4.1.11/node_modules/vitest/suppress-warnings.cjs',
    ];
    expect(childExecArgv({ parentExecArgv })).toEqual(['--import', 'tsx']);
  });

  it('a_ts_capable_loader_is_kept_and_a_cjs_preload_beside_it_is_dropped', () => {
    const parentExecArgv = [
      '--require',
      '/x/vitest/suppress-warnings.cjs',
      '--import',
      '/lt/node_modules/tsx/dist/loader.mjs',
      '--loader=ts-node/esm',
    ];
    expect(childExecArgv({ parentExecArgv })).toEqual([
      '--import',
      '/lt/node_modules/tsx/dist/loader.mjs',
      '--loader=ts-node/esm',
    ]);
  });

  it('heap_flags_are_never_inherited_by_children', () => {
    const parentExecArgv = ['--max-old-space-size=4096', '--import', 'tsx'];
    expect(childExecArgv({ parentExecArgv })).toEqual(['--import', 'tsx']);
  });

  it('a_parent_with_no_loader_flags_falls_back_to_the_historical_default', () => {
    expect(childExecArgv({ parentExecArgv: [] })).toEqual([...DEFAULT_CHILD_EXEC_ARGV]);
    expect(childExecArgv({ parentExecArgv: ['--max-old-space-size=1024'] })).toEqual([
      '--import',
      'tsx',
    ]);
  });

  it('an_explicit_override_wins_over_inheritance', () => {
    const parentExecArgv = ['--import', 'tsx'];
    expect(
      childExecArgv({ parentExecArgv, override: '["--import","/custom/loader.mjs"]' }),
    ).toEqual(['--import', '/custom/loader.mjs']);
  });

  it('a_malformed_override_is_a_named_error_never_a_silent_default', () => {
    expect(() => childExecArgv({ parentExecArgv: [], override: 'not json' })).toThrow(
      InvalidChildExecArgvOverrideError,
    );
    expect(() => childExecArgv({ parentExecArgv: [], override: '{"a":1}' })).toThrow(
      InvalidChildExecArgvOverrideError,
    );
    expect(() => childExecArgv({ parentExecArgv: [], override: '["--import", 3]' })).toThrow(
      InvalidChildExecArgvOverrideError,
    );
  });

  it('loader_flags_are_extracted_in_both_spaced_and_equals_forms_and_nothing_else', () => {
    expect(
      loaderFlagsOf([
        '--require',
        './a.cjs',
        '--trace-gc',
        '--loader=ts-node/esm',
        '--import',
        '--expose-gc',
      ]),
    ).toEqual(['--require', './a.cjs', '--loader=ts-node/esm']);
  });
});
