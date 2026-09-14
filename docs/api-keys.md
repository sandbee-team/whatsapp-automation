# API keys

An API key lets a tenant call the messaging API directly from their own code, instead of only from the panel. Create and manage keys from **Settings → API keys**.

## Creating a key in the panel

1. Go to **Settings → API keys**.
2. Click **Create key** and give it a name (1–64 characters) that helps you tell your keys apart — for example, the service or app that will use it.
3. The full key is shown **once**, immediately after creation. Copy it and store it securely; it is never shown again anywhere in the panel or any API response.

The panel only ever stores and displays a masked form of the key (its prefix and last 4 characters). If you lose the full key, revoke it and create a new one.

## Base URL

All API requests go to the same base URL as the panel's API, for example:

```
https://api.example.com
```

(Replace with your deployment's actual API host.)

## Authentication

Send the full key as a bearer token:

```
Authorization: Bearer wp_live_<12 hex chars>_<64 hex chars>
```

Requests without a valid, unrevoked key are rejected. Revoking a key in the panel takes effect immediately — any request made with a revoked key after that point is rejected.

## Mandatory `Idempotency-Key` header

Every `POST /v1/messages` request **must** include an `Idempotency-Key` header — a client-generated, unique string identifying that specific send attempt. If you retry a request with the same key, you get back the original resource instead of creating a duplicate message. A request missing this header is rejected before anything is queued.

## Request body

The request body follows the `createMessageInputSchema` contract:

```json
{
  "kind": "text",
  "recipient": "+919876543210",
  "payload": { "text": "Your order has shipped." },
  "priority": "normal"
}
```

- `kind` — `"text"`, `"image"`, or `"document"`. No other kind is accepted.
- `recipient` — an E.164 phone number (e.g. `+919876543210`) or a WhatsApp group JID (ending in `@g.us`).
- `payload` — an object whose JSON text must not exceed 2048 bytes (UTF-8). For `"text"`, `{ "text": "..." }`. For `"image"`/`"document"`, `{ "mediaId": "...", "caption": "..." }` (`caption` optional) — see **Sending media** below. A payload carrying its own `fileName` or `mimeType` is rejected; those come from the stored media asset, never from the send request.
- `priority` — one of the supported job priorities.
- `scheduledAt` — optional ISO-8601 timestamp to schedule the send for later.

## Example request

Every example below reads the key from `WP_API_KEY` rather than inlining it. Set it once in your shell, and prefer a leading space (or your shell's history-ignore setting) so the key never lands in shell history:

```bash
export WP_API_KEY='wp_live_...'   # the value shown once when you created the key
```

```bash
curl -X POST https://api.example.com/v1/messages \
  -H "Authorization: Bearer $WP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-42-confirmation" \
  -d '{
    "kind": "text",
    "recipient": "+919876543210",
    "payload": { "text": "Your order has shipped." },
    "priority": "normal"
  }'
```

## Sending media (image or document)

Sending an image or document is a two-step flow: upload the file to get a `mediaId`, then reference that `mediaId` in a normal `POST /v1/messages` call.

### 1. Upload the file

`POST /v1/media` takes the raw file bytes as the request body — not a multipart form. `Content-Type` must be the file's exact MIME type, and `kind`/`fileName` are query parameters:

```bash
curl -X POST "https://api.example.com/v1/media?kind=image&fileName=invoice.pdf" \
  -H "Authorization: Bearer $WP_API_KEY" \
  -H "Content-Type: image/png" \
  --data-binary @photo.png
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "kind": "image",
    "mimeType": "image/png",
    "sizeBytes": 182400,
    "fileName": "photo.png",
    "createdAt": "2026-09-14T00:00:00.000Z"
  }
}
```

`id` is the `mediaId` you pass to `POST /v1/messages`. Uploading the exact same bytes twice returns the same `id` rather than creating a second asset.

**Caps and allowed types:**

- `image` — up to 5 MB. Allowed types: JPEG, PNG, WebP.
- `document` — up to 20 MB. Allowed types: PDF, Word (`.doc`/`.docx`), Excel (`.xls`/`.xlsx`), plain text, CSV.

A file over its kind's cap, or of an unsupported type, is rejected before any message can reference it.

A media asset is retained for 90 days after it was last used in a send; there is no separate route to fetch the uploaded bytes back — only its metadata (`GET /v1/media/:id`).

### 2. Send it

```bash
curl -X POST https://api.example.com/v1/messages \
  -H "Authorization: Bearer $WP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-42-invoice" \
  -d '{
    "kind": "image",
    "recipient": "+919876543210",
    "payload": { "mediaId": "550e8400-e29b-41d4-a716-446655440000", "caption": "Your order has shipped." },
    "priority": "normal"
  }'
```

As with a text send, **`201 Created` means the message has been queued, not sent** — the same durable-first, background-delivery behavior described above.

## Response

**`201 Created` means the message has been queued, not sent.** Message creation is durable-first: the API writes a durable job row and returns immediately. The message is delivered by the background worker afterward, and its actual delivery status appears in the panel (and, if you have a webhook configured, as a `message.job.status_changed` event).

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "queued"
  }
}
```

## Errors

Every error response uses the same envelope shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "recipient must be a valid E.164 phone number or a @g.us group JID",
    "requestId": "req_abc123"
  }
}
```

`details` may also be present with field-level information. No stack traces or other internal detail is ever included.

## Rate limiting

Requests are rate limited per key. A request over the limit returns `429 Too Many Requests` with a `Retry-After` header (in seconds) telling you how long to wait before retrying.

## Revoking a key

Revoke a key from **Settings → API keys** at any time. Revocation is immediate: any request made with that key after revocation is rejected. A revoked key stays visible in the list (so you can see when it was revoked) but cannot be un-revoked — create a new key if you need to keep integrating.
