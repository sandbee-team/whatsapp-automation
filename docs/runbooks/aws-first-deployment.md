# First AWS deployment - EC2 + S3 + Gmail SMTP

INTERNAL - operator runbook. Written 2026-09-14 for the founder's chosen shape: one EC2 instance, an S3 bucket
for files, and Gmail (app password) for outbound email, on the AWS 12-month free tier.

Nothing here is a capacity claim (ADR 0016, ADR 0018 §8). The sizing numbers below are what the code
_requires to boot_, not what it can serve.

---

## 1. The honest free-tier problem - read before you launch anything

The free tier gives **750 hours/month of a `t2.micro` or `t3.micro`: 1 vCPU, 1 GB RAM**. The application does
not fit in 1 GB:

| Process                                                             | What it needs                                                        | Source                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `session-worker`                                                    | `WORKER_HEAP_BUDGET_MB` default **3072**, compose `mem_limit: 3584m` | `platform/config.ts`, `infra/compose/docker-compose.dev.yml` |
| `api`                                                               | a few hundred MB                                                     | -                                                            |
| `cron`, `relay`                                                     | `mem_limit: 512m` each                                               | compose                                                      |
| Postgres 17 + Redis ×2 + PgBouncer (if self-hosted on the same box) | ~1 GB together, comfortably                                          | compose                                                      |

So: **a 1 GB `t3.micro` cannot run the session worker.** Three honest options:

- **(a) Free tier, no WhatsApp sessions yet** - run `api` + `cron` + `relay` + Postgres + Redis on the micro,
  with `session-worker` stopped. Signup, panel, admin, API keys and message _enqueue_ all work; nothing is
  actually delivered to WhatsApp until a worker runs. Useful for a staging/demo box, not for a paying tenant.
- **(b) Pay for the instance that fits** - `t3.small` (2 GB) is the floor for one worker holding a handful of
  sessions, and `t3.medium` (4 GB) is the first size with real headroom. This is a few dollars a month, not a
  funding decision. **Recommended for the first real tenant.**
- **(c) Lower `WORKER_HEAP_BUDGET_MB`** - possible, but it directly lowers `MAX_SESSIONS_PER_WORKER`
  (derived, see ADR 0018 §3). Do NOT do this to make a box "fit"; the cap exists so a worker cannot OOM while
  holding live sessions.

Free tier also gives **5 GB of S3** and **30 GB of EBS** - both fine for the first months of media at the
5 MB image / 20 MB document caps, but S3 storage is the one that grows silently: media is retained 90 days
after last use.

---

## 2. What runs on the box

Four Node processes, each `ROLE=<name>` (see `app/backend/src/roles/`):

| Role             | Purpose                                                                                       | Metrics port |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------ |
| `api`            | HTTP on `PORT` (default 3000): panel, `/v1` API, webhooks, SSE. Never sends.                  | 9464         |
| `session-worker` | Holds Baileys sockets, drains the queue, sends.                                               | 9465         |
| `cron`           | Reaper, reconciler, wallet and retention sweeps. Single-flighted by a Postgres advisory lock. | 9466         |
| `relay`          | Drains `outbox_events` → Redis/webhooks/email.                                                | 9467         |

A FIFTH process, `admin-api`, runs the staff panel's backend. It is not a `ROLE` of `app/backend` - it is
`admin/backend`, with its own config block (`ADMIN_*`) and its own auth (staff argon2id + mandatory TOTP + an
IP allow-list), listening on 3001. It ships in the same image, so it needs no separate build.

**`ADMIN_IP_ALLOWED_CIDRS` defaults to an empty string, which denies every caller.** The admin panel is
unreachable until you set it. That is deliberate fail-closed behaviour, not a bug; see checklist row 25.

All five run from the SAME image (`wp-backend:<tag>`, built by the repo `Dockerfile`), which runs compiled
JavaScript - not `tsx`, and with no repository on the box. See ADR 0053.

Data services: Postgres 17, Redis (cache/control) and a SECOND Redis (`redis-sig`, `noeviction` - Signal
session state, must never evict), PgBouncer. `infra/compose/docker-compose.prod.yml` runs all of them plus
the four roles on one box; on AWS you may move to RDS + ElastiCache later, since the app only needs the URLs.
Do NOT deploy with `docker-compose.dev.yml` - it bind-mounts the repo and runs TypeScript through `tsx`, and
says so in its own comments.

`/metrics` binds to `127.0.0.1` by default and **production refuses an all-interfaces bind**
(`platform/metrics/server.ts`). Keep it loopback and scrape locally.

---

## 3. S3 - what to create, and one trap

The driver is MinIO's client (`object-store-s3.ts`), which talks to AWS S3 fine, but it is configured
MinIO-style (`endpoint + port + useSSL`), **not** by region, and it uses **static keys - there is no IAM
instance-profile support**.

1. Create the bucket **by hand, before first boot** (e.g. `wp-prod-media`), in the same region as the EC2.
2. Create an IAM user with a policy scoped to that bucket only: `s3:PutObject`, `s3:GetObject`,
   `s3:DeleteObject`, `s3:ListBucket`. Do **not** grant `s3:CreateBucket`.
3. Generate an access key + secret for that user.
4. Block public access on the bucket (default). The app streams objects server-side; **no browser ever hits
   S3 directly**, so no CORS and no bucket policy are needed.
5. Turn on default encryption (SSE-S3) - free, and one less thing to explain later.

**The trap:** the driver calls `ensureBucket()` on first `put()` and will try `makeBucket()` if the bucket
seems absent. With the policy above that call fails - which is correct and loud, _provided the bucket really
exists_. Create it first and this never fires.

Env:

```
OBJECT_STORE_DRIVER=s3
S3_ENDPOINT=s3.<region>.amazonaws.com      # e.g. s3.ap-south-1.amazonaws.com
S3_PORT=443
S3_USE_SSL=true
S3_ACCESS_KEY=<iam access key>
S3_SECRET_KEY=<iam secret>
S3_BUCKET=wp-prod-media
```

---

## 4. Gmail SMTP

Use a Google account with 2-Step Verification on, then create an **app password** (16 characters). The
account password will not work, and it must never be put in a config file.

```
MAIL_HOST=smtp.gmail.com
MAIL_PORT=465
MAIL_SECURE=true
MAIL_USER=<the sending gmail address>
MAIL_PASSWORD=<the 16-character app password>
MAIL_FROM=<the same address, or an alias Gmail is allowed to send as>
```

Port 587 also works - set `MAIL_SECURE=false` and the mailer requires STARTTLS before it will send
credentials (`platform/mailer.ts`). `MAIL_USER` and `MAIL_PASSWORD` must be set **together**; a half pair is
a boot failure on purpose (`platform/config-mail.ts`), because an unauthenticated relay refuses every mail
and the send path only logs that.

**Know the limit before you rely on it:** a consumer Gmail account allows roughly 500 recipients/day (Workspace
~2,000). This product sends verification, lockout, password-reset and notification mail - fine at 10-15
tenants, not fine at 500. Moving to SES later is a config change only (host/port/user/password), not a code
change.

---

## 5. Secrets and the key ring

- Generate the production ring with **`node scripts/gen-production-key-ring.mjs --out ./key-ring.json`**.
  Do NOT use `scripts/gen-key-ring.mjs` - it refuses to run under `WP_ENV=production` and seeds only three
  of the five purposes, so the ring it writes fails at boot with `CRYPTO_KEY_RING_INVALID`. The production
  generator prints a SHA-256 you can use to verify the three required copies are identical.
- `WP_KEY_RING_PATH` must point at a REAL key ring on the production host - never the checked-in dev fixture.
  `loadConfig` fails closed in production if it is unset.
- `WP_KEK_PURPOSES` must list every purpose the code uses. Today: `session,tenant-secrets,user-secrets,optout-pepper,api-key-pepper`.
  A purpose in the list with no key material fails at first use, not at boot - so provision material for all of them.
- The ring must exist in **exactly three places** before launch (launch-checklist row 23): the host secret
  store, the founder's offline encrypted copy, and a sealed second offline copy. Procedure and the quarterly
  drill: `docs/runbooks/key-ring-restore.md`.
- `AUTH_JWT_SECRET` (≥32 chars) is required in production; there is no dev fallback there.

---

## 6. Before the first paying tenant

These launch-checklist rows are still NOT DONE and each one is an operator action on the new host
(`docs/LAUNCH-CHECKLIST.md`):

| Row | What                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18  | pgBackRest backups running: full weekly + incremental daily + WAL archive (`infra/backup/`)                                                                         |
| 19  | Alertmanager routed to a human                                                                                                                                      |
| 20  | PITR restore rehearsed **on this host** (row 4 measured the dev box only)                                                                                           |
| 21  | The edge serves `website/out` compressed and terminates TLS (`infra/nginx/README.md`)                                                                               |
| 23  | Key ring in exactly three places                                                                                                                                    |
| 24  | `wp_app` grants verified on production (dev connects as owner and masks grant defects)                                                                              |
| 25  | Admin API env: `ADMIN_IP_ALLOWED_CIDRS`, `INTERNAL_API_ENABLED`, `INTERNAL_API_ALLOWED_CIDRS`, `ADMIN_TRUST_PROXY` behind a proxy that overwrites `X-Forwarded-For` |
| 26  | At least one staff account created                                                                                                                                  |
| 27  | Leads endpoint env (`LEADS_IP_HASH_SECRET`, `LEADS_ALLOWED_ORIGINS`, `NEXT_PUBLIC_LEADS_ENDPOINT`)                                                                  |

Also set `TRUST_PROXY` correctly: it defaults to `false`, and a wrong value here lets a caller spoof `req.ip`
and defeat every IP-scoped rate limit.

---

## 7. Order of operations

Since 2026-09-14 this is a Docker deploy (ADR 0053). The box needs **Docker only** - no pnpm, no Node, no
TypeScript, no repository checkout. One image carries all five roles and `ROLE` selects the process.

**On your build machine:**

```bash
./infra/deploy/build-image.sh              # build + smoke + trivy + save  -> .deploy/wp-backend-<tag>.tar.gz
./infra/deploy/ship-image.sh ubuntu@<host> <tag>   # rsync + load + migrate + restart
```

**On the EC2 box, once:**

1. Launch the instance (see §1 about size). Security group: 443 open, 22 from your IP only.
2. Install Docker Engine + the compose plugin. Nothing else.
3. Create the S3 bucket + IAM user (§3) and the Gmail app password (§4).
4. `sudo mkdir -p /opt/wp /etc/wp/keyring`
5. Copy `infra/deploy/wp.env.example` to `/etc/wp/wp.env`, fill every `<...>`, then
   `sudo chown root:root /etc/wp/wp.env && sudo chmod 600 /etc/wp/wp.env`. Never commit it.
6. Put the REAL key ring at `/etc/wp/keyring/key-ring.json` (never the checked-in dev fixture). It is mounted
   read-only into every container.
7. First run: `docker compose -f /opt/wp/docker-compose.prod.yml --profile tools run --rm migrate`, then
   `docker compose -f /opt/wp/docker-compose.prod.yml up -d api admin-api cron relay`.
8. Verify: sign up a real account, receive the verification mail, log in, create an API key, send one text
   message via the API, upload one image and send it.
9. Start `session-worker` only on a box that fits it (§1), then link a real WhatsApp number by QR.
   Note its `NODE_OPTIONS=--max-old-space-size` must equal `WORKER_HEAP_BUDGET_MB`; the role refuses to boot
   otherwise (`HeapBudgetMismatchError`), and the compose file already wires this.
10. Work the row list in §6 before inviting a paying tenant.

Every subsequent deploy is just the two build/ship commands above.

**Not covered yet:** the app exposes no `/healthz`, so the compose file declares no healthcheck for the four
application services and a load balancer has nothing to probe. Worth adding before the first paying tenant.
