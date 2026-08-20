// Normalizes a HeyReach webhook payload into a Google Chat message.
//
// HeyReach's payload shape is not formally versioned and differs slightly per
// event, so every field is read through a list of candidate paths and every
// widget is dropped when its value is missing. Nothing here throws on an
// unexpected body — worst case you get a card with just the event name.

const EVENTS = {
  CONNECTION_REQUEST_SENT: { emoji: "📨", label: "Connection request sent" },
  CONNECTION_REQUEST_ACCEPTED: { emoji: "🤝", label: "Connection accepted" },
  MESSAGE_SENT: { emoji: "➡️", label: "Message sent" },
  MESSAGE_REPLY_RECEIVED: { emoji: "💬", label: "Reply received" },
  EVERY_MESSAGE_REPLY_RECEIVED: { emoji: "💬", label: "Reply received" },
  INMAIL_SENT: { emoji: "➡️", label: "InMail sent" },
  INMAIL_REPLY_RECEIVED: { emoji: "💬", label: "InMail reply received" },
  FOLLOW_SENT: { emoji: "👤", label: "Follow sent" },
  LIKED_POST: { emoji: "👍", label: "Post liked" },
  VIEWED_PROFILE: { emoji: "👀", label: "Profile viewed" },
  CAMPAIGN_COMPLETED: { emoji: "🏁", label: "Campaign completed" },
  LEAD_TAG_UPDATED: { emoji: "🏷️", label: "Lead tag updated" },
};

const get = (obj, path) =>
  path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);

const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = get(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const clip = (s, n) =>
  typeof s === "string" && s.length > n ? `${s.slice(0, n - 1)}…` : s;

// Card widgets render a small HTML subset, so HTML-escape anything untrusted.
// Chat has no backslash escape, so this must not emit backslashes.
const html = (s) =>
  typeof s === "string"
    ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : s;

// The top-level `text` field uses Chat's markdown-ish syntax instead.
// There is no escape sequence, so formatting characters are simply dropped.
const plain = (s) => (typeof s === "string" ? s.replace(/[*_~`<>]/g, "") : s);

function extractMessage(body) {
  const raw = pick(
    body,
    "message",
    "messageText",
    "lastMessage",
    "text",
    "conversation.lastMessage",
  );
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const last = raw[raw.length - 1];
    return typeof last === "string" ? last : pick(last ?? {}, "body", "text", "message");
  }
  if (raw && typeof raw === "object") return pick(raw, "body", "text", "message");
  return undefined;
}

function joinName(o) {
  return (
    pick(o, "fullName", "name") ||
    [pick(o, "firstName", "first_name"), pick(o, "lastName", "last_name")]
      .filter(Boolean)
      .join(" ") ||
    undefined
  );
}

export function normalize(body) {
  const lead = body.lead ?? body.leadData ?? body;

  const name = joinName(lead);

  return {
    eventType: pick(body, "eventType", "event", "type", "webhookEventType") ?? "UNKNOWN",
    lead: {
      name,
      profileUrl: pick(lead, "profileUrl", "profile_url", "linkedinUrl", "linkedin_profile_url"),
      company: pick(lead, "companyName", "company_name", "company", "currentCompany"),
      position: pick(lead, "position", "title", "headline", "occupation"),
      email: pick(lead, "emailAddress", "email"),
      avatar: pick(lead, "profilePictureUrl", "imageUrl", "avatarUrl"),
    },
    campaign: pick(body, "campaign.name", "campaignName", "campaign.id", "campaignId"),
    sender: joinName(body.sender ?? body.linkedInAccount ?? {}) ?? pick(body, "senderName"),
    message: extractMessage(body),
    tags: pick(body, "tags", "leadTags", "tag"),
    conversationId: pick(body, "conversationId", "conversation.id", "chatroomId"),
    time: pick(body, "time", "timestamp", "createdAt", "eventTime"),
  };
}

// Stable-ish fingerprint used to drop HeyReach's retry duplicates.
export function fingerprint(e) {
  return [
    e.eventType,
    e.lead.profileUrl ?? e.lead.name ?? "?",
    e.conversationId ?? "",
    e.time ?? "",
    (e.message ?? "").slice(0, 80),
  ].join("|");
}

export function toChatMessage(e) {
  const meta = EVENTS[e.eventType] ?? { emoji: "🔔", label: e.eventType };
  const subtitleParts = [e.lead.position, e.lead.company].filter(Boolean);

  const widgets = [];

  if (e.message) {
    widgets.push({
      textParagraph: { text: `<i>${html(clip(e.message, 900))}</i>` },
    });
  }

  const facts = [
    ["Campaign", e.campaign],
    ["Sender", e.sender],
    ["Email", e.lead.email],
    ["Tags", Array.isArray(e.tags) ? e.tags.join(", ") : e.tags],
  ].filter(([, v]) => v);

  for (const [label, value] of facts) {
    widgets.push({
      decoratedText: { topLabel: label, text: html(String(value)), wrapText: true },
    });
  }

  if (e.lead.profileUrl) {
    widgets.push({
      buttonList: {
        buttons: [
          {
            text: "Open LinkedIn profile",
            onClick: { openLink: { url: e.lead.profileUrl } },
          },
        ],
      },
    });
  }

  if (widgets.length === 0) {
    widgets.push({ textParagraph: { text: "No details in payload." } });
  }

  return {
    // Fallback text: shown in notifications and by clients that can't render cards.
    text: `${meta.emoji} *${meta.label}* — ${plain(e.lead.name) ?? "unknown lead"}${
      e.campaign ? ` (${plain(String(e.campaign))})` : ""
    }`,
    cardsV2: [
      {
        cardId: `heyreach-${Date.now()}`,
        card: {
          header: {
            title: `${meta.emoji} ${meta.label}`,
            subtitle: plain([e.lead.name, ...subtitleParts].filter(Boolean).join(" · ")),
            ...(e.lead.avatar ? { imageUrl: e.lead.avatar, imageType: "CIRCLE" } : {}),
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

export { EVENTS };
