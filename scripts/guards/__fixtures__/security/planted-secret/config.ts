// KNOWN-BAD FIXTURE (P29a security-scan guard proof) - this file intentionally
// contains a fake-but-pattern-valid GitHub personal access token so the
// gitleaks `github-pat` rule has something real to fire on. The token below
// was generated once with a random-character generator (not a real
// credential, never used anywhere, never valid against any real service) and
// hardcoded here so the fixture is deterministic. Never copy this shape into
// real source.
export const PLANTED_FAKE_TOKEN = 'ghp_VxWFNr3hZCGjnDlMbRHTkWmp0xDvuGyTHSJp';
