# Edge (Caddy / nginx)

## Role

The production edge server provides:

- **TLS termination**: client-facing HTTPS; all upstream links are plain HTTP or local socket
- **Static hosting**: serves `website/out` (the compiled site export) directly from disk
- **Reverse proxy for SPAs and API**: routes `app/` and `admin/` single-page-application traffic and the backend REST API, with SSE-safe settings
- **IP forwarding**: rewrites `X-Forwarded-For` with the real client IP for the admin-api's per-IP rate limiter (see row 25 of `docs/LAUNCH-CHECKLIST.md`)
- **Compression**: gzip and brotli are load-bearing for the LCP budget on low-bandwidth networks; see **Compression** below

## Compression

The LCP artefact (`docs/evidence/P29-lcp-india4g.md`) was measured on compressed transfer. The same build served identity-encoded (no compression) fails the budget. Compression is therefore mandatory.

### Caddy

```
encode zstd gzip
file_server
root * /srv/website/out
```

### nginx

```nginx
gzip on;
gzip_types text/html text/css application/javascript application/json image/svg+xml;
gzip_min_length 1024;
gzip_comp_level 5;

brotli on;
brotli_types text/html text/css application/javascript application/json image/svg+xml;
```

**Verification command** (must print `gzip` or `br`):

```bash
curl -sI -H 'Accept-Encoding: gzip, br' https://<host>/ | grep -i content-encoding
```

This check is part of row 21 of `docs/LAUNCH-CHECKLIST.md`.

## SSE-safe proxy rules

### nginx

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
proxy_http_version 1.1;
proxy_set_header Connection '';
```

### Caddy

```
flush_interval -1
```

## X-Forwarded-For rewrite

The admin-api's lead endpoint uses `req.ip` (from `X-Forwarded-For` when `ADMIN_TRUST_PROXY=true`) to rate-limit per-IP. Never append to `X-Forwarded-For`; always replace it:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

```
header X-Forwarded-For {remote_ip}
```

## Security headers

Security headers (HSTS, CSP, etc.) are configured per-route in each application (`app/`, `admin/`, `website/`), not at the edge.
