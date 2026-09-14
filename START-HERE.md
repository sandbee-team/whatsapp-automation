# Start here

This is the WP application source, packaged on 2026-09-14 for deployment.

## Read this first

Open **`docs/runbooks/first-deploy-guide.html`** in a browser. It is a 14-step
guide written for someone who has never used AWS, with every command given in
full. Print it to PDF from the browser if you want a copy on paper
(`Ctrl+P` → Save as PDF → turn on **Background graphics**).

## What is NOT in this package, and why

| Not included | Reason |
| --- | --- |
| `.secrets/` | Holds the development database password, a Gmail app password and the key-ring path. Never ship it. You generate fresh production secrets — guide section 7. |
| `node_modules/` | Reinstalled from `pnpm-lock.yaml`. Shipping it would add ~1 GB. |
| `dist/`, `.next/`, `out/` | Build output. The Docker build produces its own. |
| `demo/` | ~450 MB of reference repositories nothing in the app imports. |
| `.memory/`, `.claude/` | Project decision history and editor config. Not needed to build or run. |

## Quick orientation

| Path | What it is |
| --- | --- |
| `Dockerfile` | Builds one image that runs all five backend roles. |
| `infra/compose/docker-compose.prod.yml` | Runs the whole product on one server. |
| `infra/deploy/wp.env.example` | Application settings. Copy to `/etc/wp/wp.env` on the server. |
| `infra/deploy/compose.env.example` | Docker Compose settings. Copy to `/opt/wp/.env`. **These two are different files — see guide section 8.** |
| `infra/deploy/build-image.sh` | Build, test, scan and save the image. |
| `infra/deploy/ship-image.sh` | Copy it to the server, migrate, restart. |
| `scripts/gen-production-key-ring.mjs` | Creates your production encryption keys. |
| `docs/evidence/DEEP-REVIEW-2026-09-14.md` | Known open issues, stated honestly. |

## Before your first paying customer

The deployment works, but four things are genuinely not ready, and they are
listed in the guide's section 12 with the reasons:

1. **Backups are documented but not connected.** Nothing is backing up until
   you set it up.
2. **There is no health-check endpoint.** A stuck process will not restart
   itself and will not alert you.
3. **The retention table on your public legal pages** promises eight rules;
   one is currently enforced.
4. **The session worker needs ~3 GB.** The AWS free tier gives 1 GB. Guide
   section 2 covers this before you spend anything.

## Verification state at packaging time

Full test gate green: **37 steps, 6,227 tests, 1,275 files** — see
`docs/evidence/GATE-GREEN-2026-09-14.md`.
