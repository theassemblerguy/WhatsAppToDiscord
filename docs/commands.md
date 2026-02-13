# Commands

All bot controls now run exclusively through Discord slash commands. Type `/` in any channel to see the available commands (the bot must share the server) or narrow the list by typing `/wa` and selecting the desired action. Commands can be invoked anywhere, but responses are ephemeral outside the control channel. The legacy `#control-room` text commands have been removed—use slash commands or the persistent buttons in the control channel.

---

## Conversation Management

### `/pairwithcode`
Request a pairing code for a specific phone number.  
Usage: `/pairwithcode number:<E.164 phone number>`

### `/chatinfo`
Show which WhatsApp chat the current channel is linked to (JID + type).  
Usage: `/chatinfo`

### `/start`
Create a brand-new WhatsApp conversation and channel link.  
Usage: `/start contact:<phone number or saved contact name>`

### `/link`
Link an existing Discord text/news channel to an existing WhatsApp chat without creating anything new.  
Usage: `/link contact:<name or number> channel:<#channel> force:<true|false>`  
Enable `force` to override a channel that is already linked to another chat.

### `/move`
Move an existing WhatsApp link (and webhook) from one channel to another.  
Usage: `/move from:<#current-channel> to:<#new-channel> force:<true|false>`

### `/list`
List all known contacts and groups, optionally filtered.  
Usage: `/list query:<optional text>`

### `/poll`
Create a WhatsApp poll from Discord.  
Usage: `/poll question:"text" options:"opt1,opt2,..." select:<count> announcement:<true|false>`  
Notes: Poll messages and live vote updates are mirrored to Discord, voting can only be done directly in WhatsApp. In newsletter-linked channels, WA2DC now tries an interactive poll first, then falls back to a text poll summary if WhatsApp rejects the payload.

### `/setpinduration`
Set the default expiration time (24h, 7d, or 30d) for WhatsApp pins created from Discord.  
Usage: `/setpinduration duration:<24h|7d|30d>`

### Newsletters

Once a newsletter is linked to a Discord channel, regular messages flow through the bridge normally (no special send command needed). WA2DC now attempts quote-threading for Discord replies, and falls back to plain reply-context text if newsletter quote payloads are rejected or unavailable. For newsletter media, WA2DC waits for WhatsApp ack outcomes, retries failed Discord-CDN media sends as buffer payloads when possible, and then falls back to text + links if media still fails.

### `/newslettercreate`
Create a WhatsApp newsletter and automatically link it to a Discord channel.  
Usage: `/newslettercreate name:"title" description:"optional text"`

### `/newsletterupdate`
Update a newsletter's name and/or description.  
Usage: `/newsletterupdate jid:<optional ...@newsletter> name:"optional" description:"optional"`  
If `jid` is omitted, the current channel must already be linked to a newsletter.

### `/newsletterpicture`
Set or remove the newsletter picture.  
Usage: `/newsletterpicture mode:<set|remove> url:<required when mode=set> jid:<optional ...@newsletter>`

### `/newsletteradmincount`
Fetch the newsletter admin count.  
Usage: `/newsletteradmincount jid:<optional ...@newsletter>`

### `/newslettersubscribers`
Fetch the current newsletter subscriber count.  
Usage: `/newslettersubscribers jid:<optional ...@newsletter>`

### `/newsletterfollow`
Follow a newsletter.  
Usage: `/newsletterfollow jid:<optional ...@newsletter>`

### `/newsletterunfollow`
Unfollow a newsletter.  
Usage: `/newsletterunfollow jid:<optional ...@newsletter>`

### `/newslettermute`
Mute a newsletter.  
Usage: `/newslettermute jid:<optional ...@newsletter>`

### `/newsletterunmute`
Unmute a newsletter.  
Usage: `/newsletterunmute jid:<optional ...@newsletter>`

### `/newsletterupdatename`
Update only the newsletter name.  
Usage: `/newsletterupdatename name:"new title" jid:<optional ...@newsletter>`

### `/newsletterupdatedescription`
Update only the newsletter description.  
Usage: `/newsletterupdatedescription description:"new text" jid:<optional ...@newsletter>`

### `/newslettermessages`
Fetch recent messages from a newsletter.  
Usage: `/newslettermessages jid:<optional ...@newsletter> count:<1-50> before:<unix seconds> after:<unix seconds>`

### `/newsletterreact`
React to a newsletter message (or remove your reaction).  
Usage: `/newsletterreact serverid:<newsletter message id> reaction:<optional emoji> jid:<optional ...@newsletter>`  
If `reaction` is omitted, WA2DC removes your existing reaction for that message.
You can also react directly with Discord emoji in linked newsletter channels; WA2DC routes those through the newsletter-specific reaction API automatically and briefly waits for server message ID resolution when needed.

### `/newslettersubscribeupdates`
Request newsletter live updates subscription metadata.  
Usage: `/newslettersubscribeupdates jid:<optional ...@newsletter>`

### `/newslettermetadata`
Fetch raw newsletter metadata (including viewer role if exposed by WhatsApp).  
Usage: `/newslettermetadata jid:<optional ...@newsletter>`

### `/newsletterinviteinfo`
Show the newsletter invite code/link exposed by WhatsApp metadata.  
Usage: `/newsletterinviteinfo jid:<optional ...@newsletter>`

### `/newsletterchangeowner`
Transfer newsletter ownership to another WhatsApp user JID/number.  
Usage: `/newsletterchangeowner user:<jid or number> jid:<optional ...@newsletter>`

### `/newsletterdemote`
Demote a newsletter admin by WhatsApp user JID/number.  
Usage: `/newsletterdemote user:<jid or number> jid:<optional ...@newsletter>`

### `/newsletterdelete`
Delete a newsletter (irreversible) and remove its local bridge mapping.  
Usage: `/newsletterdelete confirm:true jid:<optional ...@newsletter>`

---

## Whitelist Controls

### `/listwhitelist`
Show the conversations currently allowed to bridge when the whitelist is enabled.

### `/addtowhitelist`
Add a linked channel to the whitelist.  
Usage: `/addtowhitelist channel:<#channel>`

### `/removefromwhitelist`
Remove a linked channel from the whitelist.  
Usage: `/removefromwhitelist channel:<#channel>`

---

## Formatting & Prefixes

### `/setdcprefix`
Override the prefix prepended to Discord → WhatsApp messages.  
Usage: `/setdcprefix prefix:<optional text>` (omit to reset to usernames)

### `/dcprefix`
Toggle whether the configured prefix is used.  
Usage: `/dcprefix enabled:<true|false>`

### `/waprefix`
Toggle whether WhatsApp sender names are prepended inside Discord messages.  
Usage: `/waprefix enabled:<true|false>`

### `/waplatformsuffix`
Toggle whether WhatsApp messages mirrored to Discord include a suffix showing the sender platform (Android/iOS/Desktop/Web).  
Usage: `/waplatformsuffix enabled:<true|false>`

---

## Privacy

### `/hidephonenumbers`
Hide WhatsApp phone numbers on Discord (use pseudonyms when a real contact name isn’t available).  
Usage: `/hidephonenumbers enabled:<true|false>`

---

## Mentions

WA2DC can optionally translate WhatsApp @mentions into Discord user mentions, if you link a WhatsApp contact to a Discord user.
This only works for **real WhatsApp mentions** (select the person from WhatsApp’s mention picker); manually typing `@name` without selecting won’t include mention metadata and can’t be translated reliably.
If a WhatsApp contact is linked, WA2DC will also translate **Discord user @mentions** into **WhatsApp mentions** when forwarding messages from Discord to WhatsApp (you must use a real Discord mention — select the user from autocomplete so Discord inserts a `<@...>` mention).

### `/linkmention`
Link a WhatsApp contact to a Discord user so future WhatsApp @mentions ping them in Discord.  
Usage: `/linkmention contact:<phone number or saved contact name> user:<@user>`
Note: phone numbers can include `+`, spaces, or dashes; WA2DC normalizes them automatically.
Note: WhatsApp can represent the same person as a phone JID (`...@s.whatsapp.net`, “PN”) and/or a Linked-Device ID (`...@lid`, “LID”). If mentions don’t ping even though the link exists, you may be receiving **LID mentions**. You can link the LID directly by passing it as the contact value, e.g. `/linkmention contact:<someid@lid> user:<@user>`. On older versions, you may need to link **both** the PN and LID for the same contact.

### `/unlinkmention`
Remove a WhatsApp→Discord mention link for a contact.  
Usage: `/unlinkmention contact:<phone number or saved contact name>`

### `/mentionlinks`
List all configured WhatsApp→Discord mention links.

### `/jidinfo`
Show the known WhatsApp IDs (PN `@s.whatsapp.net` and/or LID `@lid`) for a contact, and whether those IDs are linked for mention pings.  
Usage: `/jidinfo contact:<phone number or saved contact name>`
How to find PN/LID:
- Easiest: run `/jidinfo contact:<name or number>` and look for lines marked `(PN)` and `(LID)`.
- Advanced: open `storage/contacts` and search for the contact name; keys ending in `@s.whatsapp.net` are PN, keys ending in `@lid` are LID.

---

## Attachments & Downloads

Defaults (out of the box):

- Local downloads are disabled (`/localdownloads enabled:true` to turn on).
- Download directory is `./downloads` and pruning is disabled (`/setdownloadlimit`, `/setdownloadmaxage`, `/setdownloadminfree` all default to `0` = off).
- Local download server is disabled; when enabled it defaults to local-only (`127.0.0.1` bind, `localhost` URLs, port `8080`).
- Download links are signed (survive restarts) and never expire by default (`/setdownloadlinkttl seconds:0`).

To make download links reachable from other devices (phone/PC), you usually want:

- `/setlocaldownloadserverbindhost host:0.0.0.0` (listen on all interfaces)
- `/setlocaldownloadserverhost host:<LAN IP or domain>` (generate URLs recipients can reach)
- Ensure firewall/port forwarding allows the configured port (default `8080`)

### `/waupload`
Toggle whether Discord attachments are uploaded to WhatsApp (vs sending as links).  
Usage: `/waupload enabled:<true|false>`

### `/waembeds`
Toggle whether Discord embed content (text and supported media) is mirrored to WhatsApp.  
Usage: `/waembeds enabled:<true|false>`  
Default: `false` (disabled).

### `/localdownloads`
Control whether large WhatsApp attachments are downloaded locally when they exceed Discord’s upload limit.  
Usage: `/localdownloads enabled:<true|false>`

### `/getdownloadmessage`
Show the current local-download notification template.

### `/setdownloadmessage`
Update the notification template.  
Usage: `/setdownloadmessage message:"text with {url}/{fileName}/..."`.

### `/getdownloaddir`
Show the folder used for downloaded files.

### `/setdownloaddir`
Change the download directory.  
Usage: `/setdownloaddir path:<folder>`

### `/setdownloadlimit`
Limit the download directory size (GB).  
Usage: `/setdownloadlimit size:<number>`

### `/setdownloadmaxage`
Delete downloaded files older than the given age (days).  
Usage: `/setdownloadmaxage days:<number>` (0 disables age-based cleanup)

### `/setdownloadminfree`
Keep at least the given free disk space (GB) by pruning old downloads.  
Usage: `/setdownloadminfree gb:<number>` (0 disables free-space pruning)

### `/setfilesizelimit`
Override the Discord upload size limit used to decide when to download instead of re-uploading.  
Usage: `/setfilesizelimit bytes:<integer>`

### `/setdownloadlinkttl`
Set local download link expiry in seconds.  
Usage: `/setdownloadlinkttl seconds:<integer>` (0 = never expire)

### `/localdownloadserver`
Start/stop the built-in HTTP(S) server that serves downloaded files.  
Usage: `/localdownloadserver enabled:<true|false>`

### `/setlocaldownloadserverhost`
Configure the hostname used in generated download URLs.  
Usage: `/setlocaldownloadserverhost host:<value>`

### `/setlocaldownloadserverbindhost`
Configure which interface the download server listens on.  
Usage: `/setlocaldownloadserverbindhost host:<value>` (e.g., `127.0.0.1` or `0.0.0.0`)

### `/setlocaldownloadserverport`
Configure which port the download server listens on.  
Usage: `/setlocaldownloadserverport port:<1-65535>`

### `/httpsdownloadserver`
Toggle HTTPS for the download server (requires certificates).  
Usage: `/httpsdownloadserver enabled:<true|false>`

### `/sethttpscert`
Set TLS certificate paths for the download server.  
Usage: `/sethttpscert key_path:<file> cert_path:<file>`

---

## Messaging Behavior

### `/deletes`
Toggle mirrored message deletions between Discord and WhatsApp.  
Usage: `/deletes enabled:<true|false>`

### `/readreceipts`
Turn read receipts on or off entirely.  
Usage: `/readreceipts enabled:<true|false>`

### `/dmreadreceipts`, `/publicreadreceipts`, `/reactionreadreceipts`
Pick the delivery style when read receipts are enabled (DM, short channel reply, or ☑️ reaction).

### `/changenotifications`
Toggle profile-picture / status-change alerts and WhatsApp Status (stories) mirroring (posted into the `status@broadcast` / `#status` channel).  
Usage: `/changenotifications enabled:<true|false>`

### `/oneway`
Restrict the bridge to one direction or keep it bidirectional.  
Usage: `/oneway direction:<discord|whatsapp|disabled>`

### `/redirectbots`
Allow or block Discord bot messages from being forwarded to WhatsApp.  
Usage: `/redirectbots enabled:<true|false>`

### `/redirectwebhooks`
Allow or block Discord webhook messages from being forwarded to WhatsApp.  
Usage: `/redirectwebhooks enabled:<true|false>`

### `/redirectannouncements`
Allow or block Discord announcement/crosspost webhooks from being forwarded to WhatsApp.  
Usage: `/redirectannouncements enabled:<true|false>`  
Default: `false` (disabled).

### Typing indicators (automatic)
When someone starts typing in a linked Discord channel, WA2DC sends WhatsApp presence updates (`composing` / `paused`) to the linked chat so your WhatsApp account shows “typing…”. This only runs when Discord → WhatsApp bridging is enabled (bidirectional or `/oneway direction:whatsapp`). WhatsApp cannot show *which* Discord user is typing—only that the bridge account is.

### `/publishing`
Toggle automatic cross-posting for messages sent to Discord news channels.  
Usage: `/publishing enabled:<true|false>`

### `/ping`
Return the current bot latency.

---

## Maintenance & Settings

### `/restart`
Safely save state and restart the bot (requires running via the watchdog runner).  
Usage: `/restart` (control channel only)

### `/resync`
Re-sync WhatsApp contacts/groups. Set `rename:true` to rename Discord channels to match WhatsApp subjects.

### `/autosaveinterval`
Change how often the bot persists state (seconds).  
Usage: `/autosaveinterval seconds:<integer>`

### `/lastmessagestorage`
Limit how many WhatsApp messages remain editable/deletable from Discord.  
Usage: `/lastmessagestorage size:<integer>`

### `/localdownloadserver`, `/setlocaldownloadserverhost`, `/setlocaldownloadserverbindhost`, `/setlocaldownloadserverport`, `/setdownloadlinkttl`, `/httpsdownloadserver`, `/sethttpscert`
See “Attachments & Downloads” above (listed again here for visibility).

---

## Update Management

The control channel now shows a persistent update card with “Update”, “Skip update”, and “Roll back” buttons that survive restarts. These buttons trigger the same slash commands listed below.

### `/updatechannel`
Switch between the stable and unstable release channels.  
Usage: `/updatechannel channel:<stable|unstable>`

### `/checkupdate`
Manually check for updates on the active channel.

### `/skipupdate`
Dismiss the current update notification without installing.

### `/update`
Download and install the available release (packaged installs only). Docker/source deployments will be reminded to pull and restart manually.  
If the updated packaged binary crash-loops during startup, the watchdog runner automatically rolls back to the previous `.oldVersion` binary (2 non-zero exits before 120 seconds uptime).

### `/rollback`
Restore the previous packaged binary when one is available. The dedicated “Roll back” button only appears if a backup exists.  
This is still useful for manual recovery, but update failures are now auto-rolled back by the watchdog runner when possible.

---

Need help remembering the command names? Type `/wa` inside Discord and let the client autocomplete each slash command along with its required options. All commands are self-documented via Discord’s UI, so you no longer have to memorize legacy text formats.
