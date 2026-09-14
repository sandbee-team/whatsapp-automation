# P29 - key-ring restore drill evidence (measured 2026-09-08)

INTERNAL - key-ring restore drill evidence; no figure here is quotable.

Date: 2026-09-08
Operator: Kartik Desai (founder)

## Environment

A scratch directory on the dev workstation, holding a production-shaped key
ring (one active key per KEK purpose, plus one retired `session` key,
matching a ring that has already been rotated once). No absolute path and no
key material appear anywhere in this file or in the measurements JSON.

## Copies exercised

- host secret store (running copy)
- founder's offline encrypted copy
- sealed second offline copy

## Steps and result

The drill provisioned the ring, wrote both offline copies, sealed a real
credential-shaped record (noise key pair, signed identity key, signed
pre-key, registration id, adv secret key - 1356 bytes plaintext) under the
active `session` key, destroyed the running copy (and proved it could no
longer be loaded), then restored the ring from the offline copy alone and
re-opened the sealed record.

**Verdict: PASS** - the restored record was byte-identical to the original
plaintext, and destruction of the running copy was proven before restore
began.

## Measured timings

| phase     | ms  |
| --------- | --- |
| provision | 1   |
| seal      | 4   |
| destroy   | 1   |
| restore   | 33  |
| verify    | 0   |

**Measured duration: 39 ms**

Full machine-readable record:
`docs/measurements/2026-09-08-keyring-restore-drill.json`.

## Record size

Plaintext: 1355 bytes. Sealed ciphertext: 1355 bytes. Wrapped under kekId
`session-active-1`.

## No key material recorded

No key bytes, no base64 material, no passphrase, and no secret storage path
appear anywhere in this file or in the measurements JSON - this is enforced
by the drill itself (`assertNoSecretLeak`), not just by hand-review.

## Next drill

Next drill due: **2026-12-08**.
