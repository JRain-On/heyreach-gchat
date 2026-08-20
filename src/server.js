import express from "express";
import { normalize, fingerprint, toChatMessage } from "./format.js";
import { sendToChat } from "./chat.js";

const {
  PORT = 3000,
  INBOUND_SECRET,
  GCHAT_WEBHOOK_URL,
  EVENT_ALLOWLIST = "",
  THREAD_BY_LEAD = "true",
  LOG_PAYLOADS = "false",
} = process.env;

if (!INBOUND_SECRET || !GCHAT_WEBHOOK_URL) {
  console.error("Missing INBOUND_SECRET or GCHAT_WEBHOOK_URL");
  process.exit(1);
}

const allowlist = new Set(
  EVENT_ALLOWLIST.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
);

// HeyReach retries a failed delivery up to 5 times over 24h. In-memory dedup
// with a 6h window is enough here — a Railway restart at worst lets one
// duplicate through.
const seen = new Map();
const DEDUP_TTL_MS = 6 * 60 * 60 * 1000;

function isDuplicate(key) {
  const now = Date.now();
  for (const [k, t] of seen) {
    if (now - t > DEDUP_TTL_MS) seen.delete(k);
    else break; // Map preserves insertion order; the rest is newer.
  }
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/heyreach/:secret", (req, res) => {
  if (req.params.secret !== INBOUND_SECRET) return res.sendStatus(404);

  // Ack immediately so HeyReach never retries because Chat was slow.
  res.sendStatus(200);

  const body = req.body ?? {};
  if (LOG_PAYLOADS === "true") {
    console.log("payload", JSON.stringify(body));
  }

  let event;
  try {
    event = normalize(body);
  } catch (err) {
    console.error("normalize failed", err);
    return;
  }

  if (allowlist.size && !allowlist.has(event.eventType.toUpperCase())) {
    console.log(`skipped ${event.eventType} (not in allowlist)`);
    return;
  }

  if (isDuplicate(fingerprint(event))) {
    console.log(`duplicate ${event.eventType}`);
    return;
  }

  const threadKey =
    THREAD_BY_LEAD === "true"
      ? event.conversationId ?? event.lead.profileUrl ?? undefined
      : undefined;

  sendToChat(GCHAT_WEBHOOK_URL, toChatMessage(event), threadKey)
    .then(() => console.log(`sent ${event.eventType} — ${event.lead.name ?? "?"}`))
    .catch((err) => console.error(`send failed ${event.eventType}`, err.message));
});

app.listen(PORT, () => console.log(`listening on :${PORT}`));
