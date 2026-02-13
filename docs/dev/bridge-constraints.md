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

## Routing gates

Routing may be restricted by deployment settings. Message-flow changes must preserve:

- `state.settings.oneWay`
- whitelist checks via `state.settings.Whitelist`
- helper checks via `utils.whatsapp.inWhitelist(...)`
- broadcast delivery mode for WhatsApp `@broadcast` chats (`sendMessage(..., ..., { broadcast: true })`
  on Discord -> WhatsApp sends)
- newsletter delivery mode for WhatsApp `@newsletter` chats:
  use standard `sendMessage`, attempt quote threading for replies, and fall back to plain reply-context text if quote payloads fail.
  For media, wait for newsletter ack outcomes before treating sends as successful; if URL media is rejected and the source is Discord CDN, retry with a buffer payload, then fall back to text/link delivery.
  Use `newsletterReactMessage(jid, serverId, reaction?)` (not generic `sendMessage(...react...)`) for reactions.
  Poll sends to newsletters should try interactive payload first, then fall back to text on send or ack rejection (commonly ack error `479`), with the same bounded ack wait policy.
  Mirror incoming WhatsApp newsletter reactions via `newsletter.reaction` events and key them by `server_id`.
  Track/resolve newsletter `server_id` mapping from outbound message ids before reaction/delete/edit actions, including bounded wait-and-retry behavior and explicit timeout feedback.
