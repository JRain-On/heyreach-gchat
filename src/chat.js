// Delivery to a Google Chat incoming webhook.
//
// Incoming webhooks are rate limited per space (roughly 60 requests/minute),
// so sends are serialized through a single promise chain with a minimum
// interval, and 429/5xx responses are retried with backoff.

const MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 4;

let chain = Promise.resolve();
let lastSentAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliver(webhookUrl, message, threadKey) {
  const url = new URL(webhookUrl);
  if (threadKey) {
    // Group everything about one lead/conversation into a single Chat thread.
    url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    message = { ...message, thread: { threadKey } };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastSentAt);
    if (wait > 0) await sleep(wait);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(message),
    });
    lastSentAt = Date.now();

    if (res.ok) return;

    const body = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;

    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(`Google Chat ${res.status}: ${body.slice(0, 300)}`);
    }

    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 500 * 2 ** attempt,
    );
  }
}

export function sendToChat(webhookUrl, message, threadKey) {
  chain = chain.then(
    () => deliver(webhookUrl, message, threadKey),
    () => deliver(webhookUrl, message, threadKey),
  );
  return chain;
}
