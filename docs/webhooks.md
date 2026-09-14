# Webhooks

Webhook endpoints let a tenant receive a POST callback whenever whitelisted events occur. Each endpoint carries its own signing secret, event subscription list, and failure tracking.

## API endpoints

All routes require `scope: webhooks:manage` and role `owner` or `admin`.

### POST /v1/webhooks/endpoints

Create a webhook endpoint.

**Request:**

```json
{
  "url": "https://receiver.example.com/webhooks",
  "events": ["message.job.status_changed", "instance.health_changed"]
}
```

**Response:** `201 Created`

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "url": "https://receiver.example.com/webhooks",
    "events": ["message.job.status_changed", "instance.health_changed"],
    "enabled": true,
    "secret": "whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "createdAt": "2026-09-02T12:00:00Z",
    "lastSuccessAt": null,
    "consecutiveFailures": 0,
    "disabledReason": null
  }
}
```

The `secret` appears only in the create response. Store it securely; you cannot retrieve it again.

### GET /v1/webhooks/endpoints

List all endpoints for the authenticated tenant.

**Response:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "url": "https://receiver.example.com/webhooks",
        "events": ["message.job.status_changed"],
        "enabled": true,
        "createdAt": "2026-09-02T12:00:00Z",
        "lastSuccessAt": "2026-09-02T13:00:00Z",
        "consecutiveFailures": 0,
        "disabledReason": null
      }
    ]
  }
}
```

### PATCH /v1/webhooks/endpoints/{id}

Update an endpoint's URL, subscribed events, or enabled status.

**Request:**

```json
{
  "url": "https://receiver.example.com/webhooks/v2",
  "events": ["message.job.status_changed", "campaign.progress"],
  "enabled": true
}
```

All fields are optional; omitted fields are not updated.

**Response:** `200 OK` — returns the updated endpoint summary (same shape as GET list items).

### DELETE /v1/webhooks/endpoints/{id}

Delete an endpoint permanently. All pending deliveries for this endpoint are also removed.

**Response:** `200 OK`

```json
{
  "success": true,
  "data": { "id": "550e8400-e29b-41d4-a716-446655440000" }
}
```

### POST /v1/webhooks/endpoints/{id}/test

Send a synthetic test event through the dispatcher to verify configuration. Returns the delivery record created, not a fake response — you can track it via webhook delivery logs.

**Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "deliveryId": "delivery_abc123def456",
    "status": "pending"
  }
}
```

Possible status values: `pending`, `sent` (HTTP 2xx received), `failed` (terminal or max retries reached).

## Subscribable events

An endpoint's `events` array must contain one or more of these event types (these are `REALTIME_EVENT_TYPES` minus `instance.qr` and `webhook.endpoint_disabled`):

- `instance.health_changed` — instance paused, resumed, or health state changed
- `instance.pacing_changed` — pacing tier/band updated
- `message.job.status_changed` — a message job's status changed (sent, failed, etc.)
- `job.needs_user_action` — a job requires manual review or duplicate-fanout acknowledgement
- `campaign.progress` — broadcast campaign sent/queued/failed counts updated
- `webhook.test` — synthetic test event (only via POST /endpoints/{id}/test)

Note: `instance.qr` (the pairing QR code) and `webhook.endpoint_disabled` (auto-disable notice) are never subscribable.

## Payload format

Each webhook POST carries:

**Headers:**

- `Content-Type: application/json`
- `X-WP-Signature: v1,t=<unix_seconds>,s=<hex_hmac_sha256>`
- `X-WP-Event-Id: <stable_uuid>` — same across redeliveries; use this to dedupe
- `X-WP-Timestamp: <unix_seconds>` — same value used in signature

**Body:** JSON object, max ~1 KB, ids and enums only:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "message.job.status_changed",
  "jobPublicId": "job_abc123",
  "instanceId": "b0e8f400-a29b-41d4-a716-446655440111",
  "status": "sent"
}
```

Payloads carry IDs and enums only — never message bodies, phone numbers, or JIDs. Always refetch business detail through the authorised API endpoint.

## Signature verification

Verify the `X-WP-Signature` header using the shared secret. The header format is:

```
X-WP-Signature: v1,t=<timestamp>,s=<signature>
```

Example Node.js verification (copy this pattern):

```javascript
import crypto from 'crypto';

function verifyWebhookSignature(
  secret,
  rawBody, // raw request body bytes, not parsed JSON
  headerValue, // the full X-WP-Signature header value
) {
  // Parse header: "v1,t=<timestamp>,s=<signature>"
  const parts = headerValue.split(',').reduce((acc, part) => {
    const [key, value] = part.split('=');
    acc[key] = value;
    return acc;
  }, {});

  const timestamp = parseInt(parts.t, 10);
  const providedSig = parts.s;

  // 1. Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return false;
  }

  // 2. Compute expected signature
  const signedContent = `${timestamp}.${rawBody}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(signedContent).digest('hex');

  // 3. Constant-time comparison
  return crypto.timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expectedSig, 'hex'));
}
```

**Important:** Always use `crypto.timingSafeEqual()` for comparison to prevent timing attacks. Always hash the raw request body bytes before JSON parsing.

## Delivery semantics

**At-least-once delivery:** a webhook event may be delivered more than once. Use the `X-WP-Event-Id` header to dedupe on your end — it remains stable across redeliveries.

Failure modes that trigger redelivery:

- HTTP timeouts
- Server errors (5xx)
- Network failures
- Crash between successful dispatch and database update (rare but possible)

On success (HTTP 2xx), the delivery is marked sent and the endpoint's failure counter resets.

## Retry policy

Failed deliveries retry with **full-jitter exponential backoff:**

- **Delay per attempt:** `delay = random(0, min(6 hours, 2 seconds × 2^attempt))`
- **Max attempts:** 8 (approximately 24 hours total)
- **Terminal codes (never retry):** 400, 401, 403, 404, 422
- **All other codes retry** (5xx, 429, network errors, timeouts)

Example retry schedule (actual delays are randomized; the delay window scheduling attempt N+1 is `random(0, 2s × 2^(N-1))`, since the formula is evaluated against the attempt count BEFORE that failure's own increment):

- After attempt 1 fails: 0–2 seconds until attempt 2
- After attempt 2 fails: 0–4 seconds until attempt 3
- After attempt 3 fails: 0–8 seconds until attempt 4
- After attempt 6 fails: 0–64 seconds until attempt 7
- After attempt 7 fails: 0–128 seconds until attempt 8
- Attempt 8 is the last try (`MAX_ATTEMPTS=8`) - if it also fails, the delivery is marked `failed` immediately, with no further retry scheduled

## Auto-disable policy

An endpoint is automatically disabled (`enabled: false`) after **20 consecutive terminal failures** (HTTP 400/401/403/404/422 or max retries exhausted).

When auto-disabled:

- The endpoint receives a `webhook.endpoint_disabled` event on the panel's SSE stream (never via webhook)
- `disabledReason` is set to `'consecutive_failures'`
- An audit log entry is created
- **The failure counter resets to 0 on the next successful delivery** (if manually re-enabled)

To re-enable, send:

```
PATCH /v1/webhooks/endpoints/{id}
{ "enabled": true }
```

Then verify with a test send:

```
POST /v1/webhooks/endpoints/{id}/test
```

## URL validation

Endpoint URLs are validated at configuration time and on every dispatch:

- HTTPS only (in production)
- No HTTP redirects followed
- Private IP ranges rejected (127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, ::1, link-local, ULA)
- No CGNAT addresses (100.64.0.0/10)

This prevents SSRF attacks and credential leakage to internal systems.
