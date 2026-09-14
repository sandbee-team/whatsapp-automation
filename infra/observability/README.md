# Observability stack

Prometheus (metrics + alert evaluation), Alertmanager (routing), Grafana
(dashboards), Loki + Alloy (log pipeline), and a redis_exporter for
`redis-sig`. Every port is loopback-published - this stack is never exposed
beyond the host it runs on.

## Start / stop

```
docker compose -f infra/observability/docker-compose.observability.yml up -d
docker compose -f infra/observability/docker-compose.observability.yml down
```

## Ports

| Service        | Port (loopback) |
| -------------- | --------------- |
| Prometheus     | 9090            |
| Alertmanager   | 9093            |
| Grafana        | 3001            |
| Loki           | 3100            |
| Alloy          | 12345           |
| redis_exporter | 9121            |

Override the bind address with `OBS_BIND` (default `127.0.0.1`).

## Secrets contract

Nothing is inlined. Alertmanager reads its two webhook URLs via
`url_file`; Grafana reads its admin password via
`GF_SECURITY_ADMIN_PASSWORD__FILE` (double underscore). Both point at
`/etc/wp/secrets/*`, which the compose file mounts from
`${WP_SECRETS_DIR:-./secrets.example}:/etc/wp/secrets:ro`.

`secrets.example/` ships three placeholder files for dev only - never real
secrets:

- `alertmanager-page-webhook-url`
- `alertmanager-ticket-webhook-url`
- `grafana-admin-password`

In production, set `WP_SECRETS_DIR=/etc/wp/secrets` and put the three real
files there with mode `0400`.

## Scrape targets

Dev scrapes are defined by `prometheus/targets/wp.dev.json`
(`file_sd_configs`, job name `wp`), one entry per backend process:
`host.docker.internal:9464` (api), `:9465` (session-worker), `:9466`
(cron), `:9467` (relay). Production replaces this file with real
service-name targets (one entry per deployed service, via whatever service
discovery the deploy target uses) - rules only ever reference `job="wp"`,
never a specific target, so the switch is transparent to every rule and
dashboard.

## Label rules

Only a small, fixed set of gauges may carry `instance_id`/`client_id` as a
Prometheus label (see `INSTANCE_LABELLED_GAUGES` in
`docs/CONVENTIONS.md`) - everything else is a JSON log field or a Postgres
rollup, never a high-cardinality label. Loki stream labels are scoped even
tighter: only `env`, `role`, `level` - `client_id`/`instance_id` stay JSON
fields inside the log line, never labels.

## Adding an alert

1. Add the rule to `prometheus/rules/wp-alerts.rules.yml` with
   `labels.severity: page|ticket`, `annotations.summary`,
   `annotations.description` (plain prose, ids only - never a templated
   tenant/recipient identifier), and `annotations.runbook_url:
docs/RUNBOOK.md#<anchor>`.
2. Add a matching `## <anchor>` H2 heading to `docs/RUNBOOK.md`.
3. Add a promtool case to `prometheus/rules/wp-alerts.test.yml` (a `# case:
<name>` comment above the test entry).
4. Run `pnpm exec tsx scripts/check-alert-rules.ts` - it parses every rule
   file, cross-checks metric names against
   `infra/observability/metrics.generated.json`, checks runbook anchors
   exist, and runs `promtool check rules` / `promtool test rules`.

## Dashboards

Dashboards are provisioned from `grafana/dashboards/*.json` (mounted
read-only into Grafana) and linted by `scripts/check-dashboards.ts` - both
owned by a separate unit of this phase, not this file.
