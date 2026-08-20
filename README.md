# HeyReach → Google Chat bridge

Stateless Node service. HeyReach POSTs an event, this reshapes it into a Google
Chat card and forwards it to a space's incoming webhook.

```
HeyReach ──POST /heyreach/<secret>──▶ Railway ──POST──▶ Google Chat space
```

## 1. Google Chat webhook

Open the space → **Apps & integrations** → **Webhooks** → **Add webhooks** →
name it → copy the URL. It contains `key` and `token` query params: treat it as
a credential, it is the only thing authenticating writes to the space.

Two constraints worth knowing up front: incoming webhooks require a Google
Workspace account (not a personal Gmail), and they work in spaces only, not DMs.

## 2. Deploy on Railway

```bash
git init && git add . && git commit -m "init"
gh repo create opsin/heyreach-gchat --private --source=. --push
```

In Railway: **New Project** → **Deploy from GitHub repo** → pick it. Nixpacks
detects Node and runs `npm start`. Then set variables (**Variables** tab):

| Variable | Value |
| --- | --- |
| `INBOUND_SECRET` | `openssl rand -hex 24` |
| `GCHAT_WEBHOOK_URL` | the URL from step 1 |
| `EVENT_ALLOWLIST` | optional, comma-separated event types |
| `THREAD_BY_LEAD` | `true` |
| `LOG_PAYLOADS` | `false` (flip to `true` while testing) |

Generate a public domain under **Settings → Networking**. Your endpoint is:

```
https://<app>.up.railway.app/heyreach/<INBOUND_SECRET>
```

## 3. HeyReach webhooks

Settings (bottom left) → **Integrations** → **Webhooks** → **View and Create**.
Give it a name, paste the URL above, pick one event type, pick the campaigns.

HeyReach has no multi-select for event types, so **create one webhook per
event**, all pointing at the same URL. A sensible starting set:

- `CONNECTION_REQUEST_ACCEPTED`
- `EVERY_MESSAGE_REPLY_RECEIVED` — prefer this over `MESSAGE_REPLY_RECEIVED`,
  which fires on the first reply only
- `LEAD_TAG_UPDATED`
- `CAMPAIGN_COMPLETED`

Skip `MESSAGE_SENT`, `VIEWED_PROFILE`, `LIKED_POST` unless you want the channel
to carry volume rather than signal.

Note: only *every reply received* and *status tag updated* fire regardless of
campaign, and both require "track and import all conversations" enabled in
HeyReach.

## 4. Verify

```bash
curl -X POST https://<app>.up.railway.app/heyreach/<INBOUND_SECRET> \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"CONNECTION_REQUEST_ACCEPTED",
       "campaign":{"name":"Test"},
       "lead":{"firstName":"Ada","lastName":"Lovelace",
               "companyName":"Analytical Engines",
               "profileUrl":"https://linkedin.com/in/example"}}'
```

## Design notes

**Payload shape.** HeyReach's webhook payload is not formally documented or
versioned, so `format.js` reads every field through a list of candidate paths
and drops widgets whose value is missing. Set `LOG_PAYLOADS=true`, trigger one
real event of each type, read the Railway logs, then tighten the paths in
`normalize()` to match what you actually receive.

**Fast ack.** The endpoint returns 200 before touching Google Chat. HeyReach
retries a failed delivery 5 times over 24h; without this, a slow Chat response
would produce duplicate messages.

**Dedup.** Retries are caught by an in-memory fingerprint set with a 6h window.
A Railway restart mid-retry could let one duplicate through — if that matters,
swap the `Map` in `server.js` for Redis.

**Threading.** Events sharing a `conversationId` (falling back to the lead's
profile URL) are posted to the same Chat thread via `threadKey`, so a lead's
whole history collapses into one thread instead of scattering.

**Rate limits.** Chat incoming webhooks cap around 60 requests/min per space.
`chat.js` serializes sends with a ~1.1s floor and retries 429/5xx with backoff.

**Auth.** HeyReach does not sign its webhooks, so there is no HMAC to verify —
the secret in the path is the whole authentication story. Rotate it by changing
the Railway variable and editing each HeyReach webhook URL.
