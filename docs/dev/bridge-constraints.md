# Bridge Constraints

> Owner: WA2DC maintainers
> Last reviewed: 2026-02-13
> Scope: Message-routing and identity constraints that prevent regressions.

## Echo-loop prevention

Bridge bounce protection relies on state trackers:

- `state.sentMessages`
- `state.sentReactions`
- `state.sentPins`

When adding new mirrored events, extend loop-prevention tracking accordingly.

## JID/LID migration hygiene

WhatsApp identifiers may be PN-based JIDs or LID-based JIDs.
Use shared helpers instead of assumptions:

- `utils.whatsapp.formatJid(...)`
- `utils.whatsapp.hydrateJidPair(...)`
- `utils.whatsapp.migrateLegacyJid(...)`

Do not hardcode behavior to `@s.whatsapp.net` or `@lid` only.

## Discord platform limits

Respect transport constraints when emitting output:

- 2000-character message limit
- use `utils.discord.partitionText(...)` for long responses
- respect file-size gating (for example `DiscordFileSizeLimit`)
- voice-note (`ptt`) sends from Discord should keep WhatsApp compatibility metadata intact (`audio/ogg; codecs=opus` when transcoded, `ptt: true`, and waveform bytes when available)

## Routing gates

Routing may be restricted by deployment settings. Message-flow changes must preserve:

- `state.settings.oneWay`
- whitelist checks via `state.settings.Whitelist`
- helper checks via `utils.whatsapp.inWhitelist(...)`
- broadcast delivery mode for WhatsApp `@broadcast` chats (`sendMessage(..., ..., { broadcast: true })`
  on Discord -> WhatsApp sends)
- newsletter delivery mode for WhatsApp `@newsletter` chats:
  outbound sends should use standard `sendMessage(...)` payloads like DMs/groups where possible.
  image/video attachments should follow `state.settings.NewsletterMediaUrlFallback`:
  when enabled, send them as plain URLs (no WhatsApp media payload) as a temporary workaround until upstream Baileys newsletter media posting is fixed.
  when disabled (default), do not send image/video attachments; emit an in-channel explanation.
  non-image/video attachments should be skipped with a user-facing notice and WhatsApp FAQ link (`https://faq.whatsapp.com/549900560675125`).
  newsletter edit/delete from Discord are intentionally not dispatched to WhatsApp; emit a Discord reminder to perform edit/delete in the WhatsApp phone app instead.
  consume raw newsletter `live_updates` notifications (when present) to map pending outbound IDs to `server_id` values as early as possible for supported flows.
  reactions should use `newsletterReactMessage(jid, serverId, reaction?)` when available.
  optional send-side hardening (ack-aware retry paths and quote fallback behavior) can be enabled with `WA2DC_NEWSLETTER_SPECIAL_FLOW=1`.
  Poll sends to newsletters should still try interactive payload first, then fall back to text on send or ack rejection (commonly ack error `479`).
  Mirror incoming WhatsApp newsletter reactions via `newsletter.reaction` and/or raw `live_updates` notifications, keyed by `server_id`.
