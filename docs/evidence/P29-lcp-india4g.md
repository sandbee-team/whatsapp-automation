# P29 - LCP on the India 4G profile (measured 2026-09-08)

INTERNAL performance evidence - no figure here is a capacity or delivery claim (ADR 0016).

## Profile: india-4g-mid-tier-mobile
- RTT: 150 ms
- Download throughput: 1600 kbps
- Upload throughput: 750 kbps
- CPU slowdown multiplier: 4x
- Mobile emulation: 412x823, DPR 1.75

## Budget
- LCP budget: 2500 ms

## Environment
- Chrome user agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
- Lighthouse version: 13.4.1

## Results

| route | LCP ms | FCP ms | TBT ms | Speed Index ms | perf score | Transfer (KB transferred / KB resource) | pass |
|---|---|---|---|---|---|---|---|
| http://127.0.0.1:3907/ | 943.0 | 793.0 | 59.0 | 793.0 | 100.0 | 195.5 / 664.1 | yes |
| http://127.0.0.1:3907/pricing/ | 1506.5 | 756.5 | 69.0 | 756.5 | 100.0 | 180.4 / 632.7 | yes |
| http://127.0.0.1:3907/docs/how-sending-is-paced/ | 1505.9 | 755.9 | 59.0 | 755.9 | 100.0 | 165.1 / 583.2 | yes |

## Critical path
- Initial chunks scanned: 8
- gsap in initial chunks: no
- Lazy gsap chunk: _next\static\chunks\180.d3e715a301c84a34.js

## Hero island
- Island off (CSS-only hero): / = 1508.9 ms
- Island on (HeroMotionIsland restored): / = 943.0 ms
- Kept: yes

Verdict: PASS

Method: simulated throttling (Lighthouse lantern), one run per route, cold cache, static export served by tests/e2e/serve-out.mjs with content-negotiated gzip/brotli compression (matching production edge behaviour); simulated throttling is deterministic for a given build and does not depend on ambient load.

## Uncompressed control
/ = 2853.2 ms, /pricing/ = 2704.2 ms, /docs/how-sending-is-paced/ = 2703.6 ms (same build, identity encoding) - FAIL; compression at the edge is load-bearing for the budget and is a launch-checklist requirement (P29a).

Note: the ~2,700-2,850 ms uncompressed figures above were produced by a
harness bug (U5b) - tests/e2e/serve-out.mjs served every asset identity
(uncompressed), so Lighthouse's simulated throttling measured a transfer
(~610 KB) no real visitor experiences: every production edge (Caddy/nginx)
serves gzip or brotli. The harness now negotiates encoding the same way,
and the compressed results above are the honest measurement.
