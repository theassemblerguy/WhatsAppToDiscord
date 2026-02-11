import discordJs from 'discord.js';
import fs from 'fs';
import { getDevice } from '@whiskeysockets/baileys';

import state from './state.js';
import utils from './utils.js';
import storage from './storage.js';
import groupMetadataCache from './groupMetadataCache.js';
import messageStore from './messageStore.js';
import { createDiscordClient } from './clientFactories.js';
import { resolveRestartFlagPath } from './runnerLogic.js';

const { Intents, Constants, MessageActionRow, MessageButton } = discordJs;

const DEFAULT_AVATAR_URL = 'https://cdn.discordapp.com/embed/avatars/0.png';
const PIN_DURATION_PRESETS = {
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

const client = createDiscordClient({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Intents.FLAGS.GUILD_MESSAGE_TYPING,
    Intents.FLAGS.MESSAGE_CONTENT,
  ],
});
let controlChannel;
let slashRegisterWarned = false;
const pendingAlbums = {};
const deliveredMessages = new Set();
const BOT_PERMISSIONS = 536879120;
const UPDATE_BUTTON_IDS = utils.discord.updateButtonIds;
const ROLLBACK_BUTTON_ID = utils.discord.rollbackButtonId;
const bridgePinnedMessages = new Set();
const pinExpiryTimers = new Map();
const DISCORD_FORWARD_CONTEXT_TTL_MS = 5 * 60 * 1000;
const DISCORD_MESSAGE_LOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const discordForwardContextCache = new Map();
const discordForwardContextTimers = new Map();
const discordMessageLocationCache = new Map();
const discordMessageLocationTimers = new Map();
let restartInProgress = false;

const requestSafeRestart = async (ctx, { message = 'Restarting...', exitCode = 0 } = {}) => {
  if (restartInProgress) {
    await ctx.reply('Restart already in progress.');
    return;
  }
  restartInProgress = true;
  state.shutdownRequested = true;

  try {
    await storage.save();
  } catch (err) {
    restartInProgress = false;
    state.shutdownRequested = false;
    state.logger?.error({ err }, 'Failed to save state before restart');
    await ctx.reply('Failed to save state; restart aborted. Check logs.');
    return;
  }

  const flagPath = resolveRestartFlagPath(process.env.WA2DC_RESTART_FLAG_PATH, process.cwd());
  let flagWritten = true;
  let resolvedExitCode = exitCode;
  try {
    await fs.promises.writeFile(flagPath, '');
  } catch (err) {
    flagWritten = false;
    resolvedExitCode = resolvedExitCode === 0 ? 1 : resolvedExitCode;
    state.logger?.error({ err, flagPath }, 'Failed to write restart flag; falling back to crash restart');
  }

  const suffix = flagWritten ? '' : ' (restart flag write failed; falling back to crash restart)';
  try {
    await ctx.reply(`${message}${suffix}`);
  } catch (err) {
    state.logger?.warn?.({ err }, 'Failed to send restart confirmation message');
  }

  try {
    utils.stopDownloadServer();
  } catch {
    /* ignore */
  }
  try {
    void Promise.resolve(state.waClient?.end?.(new Error('Restart requested'))).catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    state.waClient?.ws?.close?.();
  } catch {
    /* ignore */
  }
  try {
    state.dcClient?.destroy?.();
  } catch {
    /* ignore */
  }

  setTimeout(() => process.exit(resolvedExitCode), 250);
};

const getPinDurationSeconds = () => {
  const configured = Number(state.settings.PinDurationSeconds);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return PIN_DURATION_PRESETS['7d'];
};

const schedulePinExpiryNotice = (message, durationSeconds) => {
  const durationMs = durationSeconds * 1000;
  if (!message || durationMs <= 0) {
    return;
  }
  const existing = pinExpiryTimers.get(message.id);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(async () => {
    pinExpiryTimers.delete(message.id);
    let target = message;
    try {
      target = await message.fetch();
    } catch {
      /* best-effort */
    }
    if (!target?.pinned) return;
    bridgePinnedMessages.add(target.id);
    try {
      await target.unpin();
    } catch {
      /* ignore */
    } finally {
      bridgePinnedMessages.delete(target.id);
    }
    await target.channel?.send(`Pin expired after ${Math.round(durationSeconds / 86400)} day${durationSeconds === 86400 ? '' : 's'}.`).catch(() => {});
  }, durationMs);
  pinExpiryTimers.set(message.id, timer);
};

const clearPinExpiryNotice = (messageId) => {
  const timer = pinExpiryTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    pinExpiryTimers.delete(messageId);
  }
};

const clearTimedCacheEntry = (cache, timers, key) => {
  if (!key) return;
  const normalizedKey = String(key);
  const timer = timers.get(normalizedKey);
  if (timer) {
    clearTimeout(timer);
    timers.delete(normalizedKey);
  }
  cache.delete(normalizedKey);
};

const setTimedCacheEntry = (cache, timers, key, value, ttlMs) => {
  if (!key) return;
  const normalizedKey = String(key);
  clearTimedCacheEntry(cache, timers, normalizedKey);
  cache.set(normalizedKey, value);
  const timer = setTimeout(() => {
    cache.delete(normalizedKey);
    timers.delete(normalizedKey);
  }, ttlMs);
  timer?.unref?.();
  timers.set(normalizedKey, timer);
};

const consumeForwardContext = (messageId) => {
  if (!messageId) return null;
  const normalizedId = String(messageId);
  const context = discordForwardContextCache.get(normalizedId) || null;
  clearTimedCacheEntry(discordForwardContextCache, discordForwardContextTimers, normalizedId);
  return context;
};

const buildDiscordMessageUrl = ({ guildId, channelId, messageId }) => {
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
};

const normalizeForwardSnapshotAttachment = (attachment, index = 0) => {
  if (!attachment || typeof attachment !== 'object') return null;
  const url = attachment.url || attachment.proxy_url || attachment.proxyUrl || null;
  if (!url || typeof url !== 'string') return null;
  const id = attachment.id ? String(attachment.id) : `${index + 1}`;
  const name = attachment.filename || attachment.name || `forwarded-${id}`;
  const contentType = attachment.content_type || attachment.contentType || 'application/octet-stream';
  return {
    url,
    name,
    contentType,
  };
};

const extractForwardSnapshot = (rawData = {}) => {
  const snapshots = Array.isArray(rawData.message_snapshots)
    ? rawData.message_snapshots
    : (Array.isArray(rawData.messageSnapshots) ? rawData.messageSnapshots : []);
  if (!snapshots.length) return null;

  const rawSnapshot = snapshots[0] || {};
  const snapshotMessage = (rawSnapshot?.message && typeof rawSnapshot.message === 'object')
    ? rawSnapshot.message
    : ((rawSnapshot?.data && typeof rawSnapshot.data === 'object') ? rawSnapshot.data : rawSnapshot);

  const content = typeof snapshotMessage?.content === 'string'
    ? snapshotMessage.content
    : '';
  const snapshotAttachments = Array.isArray(snapshotMessage?.attachments) ? snapshotMessage.attachments : [];
  const attachments = snapshotAttachments
    .map((attachment, index) => normalizeForwardSnapshotAttachment(attachment, index))
    .filter(Boolean);

  if (!content && !attachments.length) return null;
  return { content, attachments };
};

const cacheDiscordMessageLocation = (message, fallbackChannelId = null) => {
  const messageId = message?.id ? String(message.id) : null;
  if (!messageId) return;
  const channelId = message?.channelId || message?.channel?.id || fallbackChannelId || null;
  const guildId = message?.guildId || message?.guild?.id || state.settings.GuildID || null;
  const url = typeof message?.url === 'string'
    ? message.url
    : buildDiscordMessageUrl({ guildId, channelId, messageId });
  if (!channelId && !url) return;
  setTimedCacheEntry(
    discordMessageLocationCache,
    discordMessageLocationTimers,
    messageId,
    { channelId: channelId || null, url: url || null },
    DISCORD_MESSAGE_LOCATION_TTL_MS,
  );
};

const buildForwardContext = (message, rawContext = null) => {
  const messageType = typeof message.type === 'number' ? Constants.MessageTypes?.[message.type] : message.type;
  const fallbackIsForwarded = Boolean(message.reference && messageType !== 'REPLY');
  const sourceChannelId = rawContext?.sourceChannelId || message.reference?.channelId || null;
  const sourceMessageId = rawContext?.sourceMessageId || message.reference?.messageId || null;
  const sourceGuildId = rawContext?.sourceGuildId || message.reference?.guildId || null;

  return {
    isForwarded: rawContext ? Boolean(rawContext.isForwarded) : fallbackIsForwarded,
    sourceChannelId,
    sourceMessageId,
    sourceGuildId,
  };
};

const resolveForwardSourceFromQuote = async (message) => {
  const quotedWaId = message?.quote?.id;
  const quotedSourceJid = utils.whatsapp.formatJid(message?.quote?.sourceJid);
  if (!quotedWaId && !quotedSourceJid) return null;

  const mappedDiscordId = quotedWaId ? state.lastMessages?.[quotedWaId] : null;
  if (typeof mappedDiscordId !== 'string' || !mappedDiscordId) {
    if (quotedSourceJid && state.chats?.[quotedSourceJid]?.channelId) {
      return {
        channelId: state.chats[quotedSourceJid].channelId,
        url: null,
      };
    }
    return null;
  }

  const cached = discordMessageLocationCache.get(mappedDiscordId);
  if (cached) {
    return {
      channelId: cached.channelId || null,
      url: cached.url || null,
    };
  }

  const channelIds = [...new Set(
    Object.values(state.chats || {})
      .map((chat) => chat?.channelId)
      .filter(Boolean),
  )];
  for (const channelId of channelIds) {
    // eslint-disable-next-line no-await-in-loop
    const channel = await utils.discord.getChannel(channelId);
    if (!channel?.messages?.fetch) continue;
    // eslint-disable-next-line no-await-in-loop
    const found = await channel.messages.fetch(mappedDiscordId).catch(() => null);
    if (!found) continue;
    cacheDiscordMessageLocation(found, channelId);
    const resolved = discordMessageLocationCache.get(mappedDiscordId);
    if (resolved) {
      return {
        channelId: resolved.channelId || channelId,
        url: resolved.url || null,
      };
    }
    return {
      channelId,
      url: buildDiscordMessageUrl({
        guildId: found.guildId || state.settings.GuildID || null,
        channelId,
        messageId: mappedDiscordId,
      }),
    };
  }

  return null;
};

class CommandResponder {
  constructor({ interaction, channel }) {
    this.interaction = interaction;
    this.channel = channel;
    this.replied = false;
    this.deferred = false;
    this.firstEditSent = false;
    this.ephemeral = interaction ? interaction.channelId !== state.settings.ControlChannelID : false;
  }

  async defer() {
    if (!this.interaction || this.deferred || this.replied) {
      return;
    }
    this.deferred = true;
    this.replied = true;
    await this.interaction.deferReply({ ephemeral: this.ephemeral });
  }

  async send(payload) {
    const normalized = typeof payload === 'string' ? { content: payload } : payload;
    if (this.interaction) {
      if (this.deferred) {
        if (!this.firstEditSent) {
          this.firstEditSent = true;
          return this.interaction.editReply(normalized);
        }
        return this.interaction.followUp({ ...normalized, ephemeral: this.ephemeral });
      }
      if (!this.replied) {
        this.replied = true;
        return this.interaction.reply({ ...normalized, ephemeral: this.ephemeral });
      }
      return this.interaction.followUp({ ...normalized, ephemeral: this.ephemeral });
    }

    return this.channel?.send(normalized);
  }

  async sendPartitioned(text) {
    const parts = utils.discord.partitionText(text || '');
    for (const part of parts) {
      // eslint-disable-next-line no-await-in-loop
      await this.send(part);
    }
  }
}

class CommandContext {
  constructor({ interaction, responder }) {
    this.interaction = interaction;
    this.responder = responder;
  }

  get channel() {
    return this.interaction?.channel ?? null;
  }

  get createdTimestamp() {
    return this.interaction?.createdTimestamp ?? Date.now();
  }

  get isControlChannel() {
    return this.channel?.id === state.settings.ControlChannelID;
  }

  async reply(payload) {
    return this.responder.send(payload);
  }

  async replyPartitioned(text) {
    return this.responder.sendPartitioned(text);
  }

  async defer() {
    return this.responder.defer();
  }

  getStringOption(name) {
    return this.interaction?.options?.getString(name);
  }

  getBooleanOption(name) {
    return this.interaction?.options?.getBoolean(name);
  }

  getIntegerOption(name) {
    return this.interaction?.options?.getInteger(name);
  }

  getNumberOption(name) {
    return this.interaction?.options?.getNumber(name);
  }

  getChannelOption(name) {
    return this.interaction?.options?.getChannel(name);
  }

  getUserOption(name) {
    return this.interaction?.options?.getUser(name);
  }

}

const sendWhatsappMessage = async (message, mediaFiles = [], messageIds = []) => {
  let msgContent = '';
  const files = [];
  const largeFiles = [];
  let components = [];
  const webhook = await utils.discord.getOrCreateChannel(message.channelJid);
  const avatarURL = message.profilePic || DEFAULT_AVATAR_URL;
  const mentionIdsRaw = Array.isArray(message?.discordMentions) ? message.discordMentions : [];
  const mentionIds = [...new Set(mentionIdsRaw.map((id) => String(id)).filter((id) => /^\d+$/.test(id)))];
  const allowedMentions = mentionIds.length ? { parse: [], users: mentionIds } : undefined;
  const content = utils.discord.convertWhatsappFormatting(message.content);
  const quoteContent = message.quote ? utils.discord.convertWhatsappFormatting(message.quote.content) : null;
  const forwardedSource = message.isForwarded ? await resolveForwardSourceFromQuote(message) : null;

  if (message.isGroup && state.settings.WAGroupPrefix) { msgContent += `[${message.name}] `; }

  if (message.isForwarded) {
    const lines = ['Forwarded'];
    if (forwardedSource?.channelId) {
      lines.push(`Source: <#${forwardedSource.channelId}>`);
    }
    if (forwardedSource?.url) {
      lines.push(`Jump: ${forwardedSource.url}`);
    }
    const forwardedBody = (content || '').split('\n').join('\n> ');
    if (forwardedBody) {
      lines.push(`> ${forwardedBody}`);
    }
    msgContent += lines.join('\n');
  }
  else if (message.quote) {
    const lines = [];

    const qContentRaw = quoteContent ?? '';
    const qContent = qContentRaw ? qContentRaw.split('\n').join('\n> ') : '';
    if (message.quote.name || qContent) {
      let quoteLine = '> ';
      if (message.quote.name) {
        quoteLine += message.quote.name;
        quoteLine += qContent ? ': ' : ':';
      }
      if (qContent) {
        quoteLine += qContent;
      }
      lines.push(quoteLine.trimEnd());
    }

    let segment = lines.join('\n');
    if (content) {
      segment += (segment ? '\n' : '') + content;
    }
    msgContent += segment || content || '';

    if (message.quote.file) {
      if (message.quote.file.largeFile && state.settings.LocalDownloads) {
        largeFiles.push(message.quote.file);
      } else if (message.quote.file === -1 && !state.settings.LocalDownloads) {
        msgContent += "WA2DC Attention: Received a file, but it's over Discord's upload limit. Check WhatsApp on your phone or enable local downloads.";
      } else {
        files.push(message.quote.file);
      }
    }
  }
  else {
    msgContent += content;
  }

  for (const file of mediaFiles) {
    if (file.largeFile && state.settings.LocalDownloads) {
      largeFiles.push(file);
    }
    else if (file === -1 && !state.settings.LocalDownloads) {
      msgContent += "WA2DC Attention: Received a file, but it's over Discord's upload limit. Check WhatsApp on your phone or enable local downloads.";
    } else if (file !== -1) {
      files.push(file);
    }
  }

  if (!msgContent && !files.length && largeFiles.length) {
    const count = largeFiles.length;
    msgContent = `WA2DC: Received ${count} attachment${count === 1 ? '' : 's'} larger than Discord's upload limit. Download link${count === 1 ? '' : 's'} will be posted shortly.`;
  }

  if (message.isPoll && Array.isArray(message.pollOptions) && message.pollOptions.length) {
    const note = '\n\nPoll voting is only available on WhatsApp. Please vote from your phone.';
    msgContent = (msgContent || message.content || 'Poll') + note;
    components = [];
  }

  if (state.settings.WASenderPlatformSuffix) {
    const idForDevice = typeof messageIds?.[0] === 'string' ? messageIds[0] : message?.id;
    let platformLabel = null;
    if (typeof idForDevice === 'string' && idForDevice.trim()) {
      try {
        const device = getDevice(idForDevice);
        if (device === 'ios') platformLabel = 'iOS';
        else if (device === 'web') platformLabel = 'Web';
        else if (device === 'android') platformLabel = 'Android';
        else if (device === 'desktop') platformLabel = 'Desktop';
      } catch {
        platformLabel = null;
      }
    }

    if (platformLabel) {
      const tag = `*(${platformLabel})*`;
      if (msgContent) {
        msgContent = `${msgContent}\n\n${tag}`;
      } else if (files.length || largeFiles.length) {
        msgContent = tag;
      }
    }
  }

  if (msgContent) {
    const normalization = utils.discord.ensureExplicitUrlScheme(msgContent);
    msgContent = normalization.text;
  }

  if (message.isEdit) {
    const dcMessageId = state.lastMessages[message.id];
    if (dcMessageId) {
      try {
        await utils.discord.safeWebhookEdit(webhook, dcMessageId, { content: msgContent || null, components, allowedMentions }, message.channelJid);
        return;
      } catch (err) {
        state.logger?.error(err);
      }
    }
    msgContent = `Edited message:\n${msgContent}`;
    const dcMessage = await utils.discord.safeWebhookSend(webhook, {
      content: msgContent,
      username: message.name,
      avatarURL,
      components,
      allowedMentions,
    }, message.channelJid);
    cacheDiscordMessageLocation(dcMessage, webhook.channelId);
    if (message.id != null) {
      // bidirectional map automatically stores both directions
      state.lastMessages[dcMessage.id] = message.id;
    }
    return;
  }

  if (msgContent || files.length) {
    msgContent = utils.discord.partitionText(msgContent);
    while (msgContent.length > 1) {
      // eslint-disable-next-line no-await-in-loop
      await utils.discord.safeWebhookSend(webhook, {
        content: msgContent.shift(),
        username: message.name,
        avatarURL,
        components,
        allowedMentions,
      }, message.channelJid);
    }

    const chunkArray = (arr, size) => {
      const chunks = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    };

    const fileChunks = chunkArray(files, 10);
    const idChunks = chunkArray(messageIds.length ? messageIds : [message.id], 10);

    if (!fileChunks.length) fileChunks.push([]);

    let lastDcMessage;
    for (let i = 0; i < fileChunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const sendArgs = {
        content: i === 0 ? (msgContent.shift() || null) : null,
        username: message.name,
        files: fileChunks[i],
        avatarURL,
        components,
        allowedMentions,
      };
      lastDcMessage = await utils.discord.safeWebhookSend(webhook, sendArgs, message.channelJid);
      cacheDiscordMessageLocation(lastDcMessage, webhook.channelId);

      if (i === 0 && lastDcMessage.channel.type === 'GUILD_NEWS' && state.settings.Publish) {
        // eslint-disable-next-line no-await-in-loop
        await lastDcMessage.crosspost();
      }

      if (message.id != null) {
        for (const waId of idChunks[i] || []) {
          // bidirectional map automatically stores both directions
          state.lastMessages[waId] = lastDcMessage.id;
        }
        if (i === 0) {
          // store mapping for Discord -> first WhatsApp id for edits
          state.lastMessages[lastDcMessage.id] = message.id;
        }
      }
    }

    if (largeFiles.length) {
      const placeholders = [];
      for (const file of largeFiles) {
        // eslint-disable-next-line no-await-in-loop
        const placeholder = await utils.discord.safeWebhookSend(webhook, {
          content: `WA2DC: downloading "${file?.name || 'attachment'}"...`,
          username: message.name,
          avatarURL,
          components: [],
        }, message.channelJid);
        placeholders.push(placeholder);
      }

      void (async () => {
        for (let i = 0; i < largeFiles.length; i += 1) {
          const file = largeFiles[i];
          const placeholder = placeholders[i];
          let downloadMessage;
          try {
            // eslint-disable-next-line no-await-in-loop
            downloadMessage = await utils.discord.downloadLargeFile(file);
          } catch (err) {
            state.logger?.error({ err }, 'Failed to download large WhatsApp attachment for local serving');
            downloadMessage = `WA2DC Attention: Failed to download "${file?.name || 'attachment'}". Please check WhatsApp.`;
          }
          const content = String(downloadMessage || '').replace(/^\n+/, '').trim() || 'WA2DC Attention: Download completed, but no message was generated.';
          try {
            // eslint-disable-next-line no-await-in-loop
            await utils.discord.safeWebhookEdit(webhook, placeholder.id, { content }, message.channelJid);
          } catch (err) {
            state.logger?.warn?.({ err }, 'Failed to update local-download placeholder message');
          }
        }
      })();
    }
  }
};

const flushAlbum = async (key) => {
  const album = pendingAlbums[key];
  if (!album) return;
  clearTimeout(album.timer);
  delete pendingAlbums[key];
  try {
    await sendWhatsappMessage(album.message, album.files, album.ids);
  } catch (err) {
    state.logger?.error({ err }, 'Failed to forward WhatsApp album to Discord');
  }
};

const setControlChannel = async () => {
  controlChannel = await utils.discord.getControlChannel();
};

client.on('ready', async () => {
  await setControlChannel();
  await registerSlashCommands();
});

client.on('channelDelete', async (channel) => {
  if (channel.id === state.settings.ControlChannelID) {
    controlChannel = await utils.discord.getControlChannel();
  } else {
    const jid = utils.discord.channelIdToJid(channel.id);
    delete state.chats[jid];
    delete state.goccRuns[jid];
    state.settings.Categories = state.settings.Categories.filter((id) => channel.id !== id);
  }
});

const WA_TYPING_IDLE_MS = 12_000;
const WA_TYPING_REFRESH_MS = 8_000;
const WA_TYPING_MIN_SEND_GAP_MS = 3_000;

const typingPresenceSessions = new Map();

const endTypingPresenceSession = (channelId) => {
  const session = typingPresenceSessions.get(channelId);
  if (!session) return;
  typingPresenceSessions.delete(channelId);

  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.refreshTimer) clearInterval(session.refreshTimer);

  state.waClient?.sendPresenceUpdate?.('paused', session.jid).catch(() => {});
};

const maybeSendComposingPresence = (channelId) => {
  const session = typingPresenceSessions.get(channelId);
  if (!session || !session.jid) return;
  if (!state.waClient?.sendPresenceUpdate) return;

  const now = Date.now();
  if (now - session.lastComposingSentAt < WA_TYPING_MIN_SEND_GAP_MS) return;
  session.lastComposingSentAt = now;

  state.waClient.sendPresenceUpdate('composing', session.jid).catch(() => {});
};

const noteDiscordTypingInChannel = (channelId, jid) => {
  const now = Date.now();
  let session = typingPresenceSessions.get(channelId);
  if (!session) {
    session = {
      jid,
      lastActivityAt: now,
      lastComposingSentAt: 0,
      idleTimer: null,
      refreshTimer: null,
    };
    typingPresenceSessions.set(channelId, session);
  } else {
    session.jid = jid;
    session.lastActivityAt = now;
  }

  maybeSendComposingPresence(channelId);

  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => endTypingPresenceSession(channelId), WA_TYPING_IDLE_MS);
  session.idleTimer?.unref?.();

  if (session.refreshTimer) return;
  session.refreshTimer = setInterval(() => {
    const current = typingPresenceSessions.get(channelId);
    if (!current) {
      clearInterval(session.refreshTimer);
      return;
    }

    const age = Date.now() - current.lastActivityAt;
    if (age >= WA_TYPING_IDLE_MS) {
      endTypingPresenceSession(channelId);
      return;
    }
    if (Date.now() - current.lastComposingSentAt >= WA_TYPING_REFRESH_MS) {
      maybeSendComposingPresence(channelId);
    }
  }, WA_TYPING_REFRESH_MS);
  session.refreshTimer?.unref?.();
};

client.on('typingStart', async (typing) => {
  if ((state.settings.oneWay >> 1 & 1) === 0) return;

  const user = typing?.user;
  if (user?.bot) return;
  if (user?.id && client.user?.id && user.id === client.user.id) return;

  const channelId = typing?.channel?.id;
  const jid = channelId ? utils.discord.channelIdToJid(channelId) : null;
  if (!jid || !state.waClient?.sendPresenceUpdate) return;

  noteDiscordTypingInChannel(channelId, jid);
});

client.on('whatsappMessage', async (message) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }
  try {
    const key = `${message.channelJid}:${message.name}`;

    if (message.file && !message.isEdit) {
      if (pendingAlbums[key]) {
        pendingAlbums[key].files.push(message.file);
        pendingAlbums[key].ids.push(message.id);
        clearTimeout(pendingAlbums[key].timer);
        pendingAlbums[key].timer = setTimeout(() => flushAlbum(key), 500);
        return;
      }
      pendingAlbums[key] = {
        message,
        files: [message.file],
        ids: [message.id],
        timer: setTimeout(() => flushAlbum(key), 500),
      };
      return;
    }

    if (pendingAlbums[key]) {
      await flushAlbum(key);
    }

    await sendWhatsappMessage(message, message.file ? [message.file] : []);
  } catch (err) {
    state.logger?.error({ err }, 'Failed to process incoming WhatsApp message');
  }
});

client.on('whatsappReaction', async (reaction) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }

  const channelId = state.chats[reaction.jid]?.channelId;
  const messageId = state.lastMessages[reaction.id];
  if (channelId == null || messageId == null) { return; }

  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(messageId);
  const msgReactions = state.reactions[messageId] || (state.reactions[messageId] = {});
  const prev = msgReactions[reaction.author];
  if (prev) {
    await message.reactions.cache.get(prev)?.remove().catch(() => {});
    delete msgReactions[reaction.author];
  }
  if (reaction.text) {
    await message.react(reaction.text).catch(async err => {
      if (err.code === 10014) {
        await channel.send(`Unknown emoji reaction (${reaction.text}) received. Check WhatsApp app to see it.`);
      }
    });
    msgReactions[reaction.author] = reaction.text;
  }
  if (!Object.keys(msgReactions).length) {
    delete state.reactions[messageId];
  }
});

client.on('whatsappRead', async ({ id, jid }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0 || !state.settings.ReadReceipts) { return; }
  const channelId = state.chats[jid]?.channelId;
  const messageId = state.lastMessages[id];
  if (!channelId || !messageId || deliveredMessages.has(messageId)) { return; }
  deliveredMessages.add(messageId);
  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) { return; }
  const receiptMode = state.settings.ReadReceiptMode;

  if (message.webhookId) {
    await message.react('☑️').catch(() => {});
    return;
  }

  if (receiptMode === 'dm') {
    const name = utils.whatsapp.jidToName(jid);
    const messageContent = (message.cleanContent ?? message.content ?? '').trim();
    let quote = null;

    if (messageContent) {
      const truncated = messageContent.length > 1800 ? `${messageContent.slice(0, 1797)}...` : messageContent;
      quote = truncated
        .split('\n')
        .map((line) => `> ${line || ' '}`)
        .join('\n');
    } else if (message.attachments?.size) {
      const attachments = [...message.attachments.values()].map((attachment) => attachment.name || attachment.url);
      const [firstAttachment, ...restAttachments] = attachments;
      quote = `> [Attachment] ${firstAttachment}`;
      if (restAttachments.length) {
        quote += `\n> ... (${restAttachments.length} more attachment${restAttachments.length === 1 ? '' : 's'})`;
      }
    } else {
      quote = '> *(No text content)*';
    }

    const receiptLines = [`✅ Your message to ${name} was read.`];
    if (quote) {
      receiptLines.push('', quote);
    }
    if (message.url) {
      receiptLines.push('', message.url);
    }

    message.author.send(receiptLines.join('\n')).catch(() => {});
    return;
  }

  if (receiptMode === 'reaction') {
    await message.react('☑️').catch(() => {});
    return;
  }

  const receipt = await channel.send({ content: '✅ Read', reply: { messageReference: messageId } }).catch(() => null);
  if (receipt) {
    setTimeout(() => receipt.delete().catch(() => {}), 5000);
  }
});

client.on('whatsappDelete', async ({ id, jid }) => {
  if (!state.settings.DeleteMessages || (state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }

  const messageId = state.lastMessages[id];
  if (state.chats[jid] == null || messageId == null) {
    return;
  }

  const webhook = await utils.discord.getOrCreateChannel(jid);
  try {
    await utils.discord.safeWebhookDelete(webhook, messageId, jid);
  } catch {
    try {
      await utils.discord.safeWebhookEdit(
        webhook,
        messageId,
        { content: 'Message Deleted' },
        jid,
      );
    } catch (err) {
      state.logger?.error(err);
    }
  }
  delete state.lastMessages[id];
  delete state.lastMessages[messageId];
  clearTimedCacheEntry(discordMessageLocationCache, discordMessageLocationTimers, messageId);
});

client.on('whatsappCall', async ({ call, jid }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }
  
  const webhook = await utils.discord.getOrCreateChannel(jid);

  const name = utils.whatsapp.jidToName(jid);
  const callType = call.isVideo ? 'video' : 'voice';
  let content = '';

  switch (call.status) {
    case 'offer':
      content = `${name} is ${callType} calling you! Check your phone to respond.`
      break;
    case 'timeout':
      content = `Missed a ${callType} call from ${name}!`
      break;
  }

  if (content !== '') {
    const avatarURL = (await utils.whatsapp.getProfilePic(call)) || DEFAULT_AVATAR_URL;
    await utils.discord.safeWebhookSend(webhook, {
      content,
      username: name,
      avatarURL,
    }, jid);
  }
});

client.on('whatsappPin', async ({ jid, key, pinned }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }
  const channelId = state.chats[jid]?.channelId;
  const dcMessageId = state.lastMessages[key.id];
  if (!channelId || !dcMessageId) {
    return;
  }
  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(dcMessageId).catch(() => null);
  if (!message) {
    return;
  }
  bridgePinnedMessages.add(message.id);
  try {
    if (pinned) {
      await message.pin();
      schedulePinExpiryNotice(message, getPinDurationSeconds());
    } else {
      await message.unpin();
      clearPinExpiryNotice(message.id);
    }
  } catch (err) {
    state.logger?.warn({ err }, 'Failed to sync WhatsApp pin to Discord');
  } finally {
    setTimeout(() => bridgePinnedMessages.delete(message.id), 5000);
  }
});

const { ApplicationCommandOptionTypes } = Constants;

const commandHandlers = {
  ping: {
    description: 'Check the bot latency.',
    async execute(ctx) {
      await ctx.reply(`Pong ${Date.now() - ctx.createdTimestamp}ms!`);
    },
  },
  chatinfo: {
    description: 'Show which WhatsApp chat this channel is linked to.',
    async execute(ctx) {
      const jid = utils.discord.channelIdToJid(ctx.channel?.id);
      if (!jid) {
        await ctx.reply('This channel is not linked to a WhatsApp chat.');
        return;
      }

      const name = utils.whatsapp.jidToName(jid);
      const displayJid = utils.whatsapp.formatJidForDisplay(jid) || jid;
      const type = jid === 'status@broadcast'
        ? 'Status'
        : (jid.endsWith('@g.us') ? 'Group' : 'DM');

      await ctx.reply(`Linked chat: **${name}**\nJID: \`${displayJid}\`\nType: ${type}`);
    },
  },
  pairwithcode: {
    description: 'Request a WhatsApp pairing code.',
    options: [
      {
        name: 'number',
        description: 'Phone number with country code.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const number = ctx.getStringOption('number');
      if (!number) {
        await ctx.reply('Please enter your number. Usage: `pairWithCode <number>`. Don\'t use "+" or any other special characters.');
        return;
      }

      const code = await state.waClient.requestPairingCode(number);
      await ctx.reply(`Your pairing code is: ${code}`);
    },
  },
  start: {
    description: 'Start a conversation with a contact or number.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      if (!contact) {
        await ctx.reply('Please enter a phone number or name. Usage: `start <number with country code or name>`.');
        return;
      }

      // eslint-disable-next-line no-restricted-globals
      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`Couldn't find \`${contact}\`.`);
        return;
      }
      const webhook = await utils.discord.getOrCreateChannel(jid);
      if (!webhook) {
        await ctx.reply('Failed to start the conversation. Please try again.');
        return;
      }

      if (state.settings.Whitelist.length) {
        const normalized = utils.whatsapp.formatJid(jid);
        if (normalized && !state.settings.Whitelist.includes(normalized)) {
          state.settings.Whitelist.push(normalized);
        }
      }

      const channelMention = webhook.channelId ? `<#${webhook.channelId}>` : 'the linked channel';
      await ctx.reply(`Started a conversation in ${channelMention}.`);
    },
  },
  poll: {
    description: 'Create a WhatsApp poll in this channel.',
    options: [
      {
        name: 'question',
        description: 'Poll question/title.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'options',
        description: 'Comma-separated options (min 2).',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'select',
        description: 'How many options can be selected.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: false,
      },
      {
        name: 'announcement',
        description: 'Send as an announcement-group poll.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const jid = utils.discord.channelIdToJid(ctx.channel?.id);
      if (!jid) {
        await ctx.reply('This command only works in channels linked to WhatsApp chats.');
        return;
      }
      const question = ctx.getStringOption('question')?.trim();
      const rawOptions = ctx.getStringOption('options') || '';
      const values = rawOptions.split(',').map((opt) => opt.trim()).filter(Boolean);
      if (!question) {
        await ctx.reply('Please provide a poll question.');
        return;
      }
      if (values.length < 2) {
        await ctx.reply('Please provide at least two poll options (comma-separated).');
        return;
      }
      const selectableCount = ctx.getIntegerOption('select') || 1;
      if (selectableCount < 1 || selectableCount > values.length) {
        await ctx.reply('Selectable count must be at least 1 and no more than the number of options.');
        return;
      }
      const toAnnouncementGroup = Boolean(ctx.getBooleanOption('announcement'));
      try {
        const sent = await state.waClient.sendMessage(jid, {
          poll: {
            name: question,
            values,
            selectableCount,
            toAnnouncementGroup,
          },
        });
        messageStore.set(sent);
        await ctx.reply('Poll sent to WhatsApp!');
      } catch (err) {
        state.logger?.error({ err }, 'Failed to send poll to WhatsApp');
        await ctx.reply('Failed to send the poll to WhatsApp. Please try again.');
      }
    },
  },
  setpinduration: {
    description: 'Set the default pin duration for WhatsApp pins.',
    options: [
      {
        name: 'duration',
        description: 'How long pins last by default.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
        choices: [
          { name: '24 hours', value: '24h' },
          { name: '7 days', value: '7d' },
          { name: '30 days', value: '30d' },
        ],
      },
    ],
    async execute(ctx) {
      const choice = ctx.getStringOption('duration');
      const seconds = PIN_DURATION_PRESETS[choice];
      if (!seconds) {
        await ctx.reply('Invalid duration. Choose 24h, 7d, or 30d.');
        return;
      }
      state.settings.PinDurationSeconds = seconds;
      await ctx.reply(`Default pin duration set to ${choice}.`);
    },
  },
  link: {
    description: 'Link a WhatsApp chat to an existing channel.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'channel',
        description: 'Target Discord channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'force',
        description: 'Override an existing link.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const force = Boolean(ctx.getBooleanOption('force'));
      const channel = ctx.getChannelOption('channel');
      const contactQuery = ctx.getStringOption('contact');

      if (!channel || !contactQuery) {
        await ctx.reply('Please provide a contact and a channel. Usage: `link <number with country code or name> #<channel>`');
        return;
      }

      if (channel.id === state.settings.ControlChannelID) {
        await ctx.reply('The control channel cannot be linked. Please choose another channel.');
        return;
      }

      if (channel.guildId !== state.settings.GuildID) {
        await ctx.reply('Please choose a channel from the configured Discord server.');
        return;
      }

      if (!['GUILD_TEXT', 'GUILD_NEWS'].includes(channel.type)) {
        await ctx.reply('Only text channels can be linked. Please choose a text channel.');
        return;
      }

      const jid = utils.whatsapp.toJid(contactQuery);
      const normalizedJid = utils.whatsapp.formatJid(jid);
      if (!normalizedJid) {
        await ctx.reply(`Couldn't find \`${contactQuery}\`.`);
        return;
      }

      const existingJid = utils.discord.channelIdToJid(channel.id);
      const forcedTakeover = Boolean(existingJid && existingJid !== normalizedJid && force);
      let displacedChat;
      let displacedRun;
      if (existingJid && existingJid !== normalizedJid) {
        if (!force) {
          await ctx.reply('That channel is already linked to another WhatsApp conversation. Enable the force option (or use the move command) to override it.');
          return;
        }
        displacedChat = state.chats[existingJid];
        displacedRun = state.goccRuns[existingJid];
        delete state.chats[existingJid];
        delete state.goccRuns[existingJid];
      }

      let webhook;
      try {
        const webhooks = await channel.fetchWebhooks();
        webhook = webhooks.find((hook) => hook.token && hook.owner?.id === client.user.id);
        if (!webhook) {
          webhook = await channel.createWebhook('WA2DC');
        }
      } catch (err) {
        state.logger?.error(err);
        await ctx.reply('Failed to access or create a webhook for that channel. Check the bot\'s permissions.');
        return;
      }

      const previousChat = state.chats[normalizedJid];
      const previousChannelId = previousChat?.channelId;
      const previousRun = state.goccRuns[normalizedJid];
      state.chats[normalizedJid] = {
        id: webhook.id,
        type: webhook.type,
        token: webhook.token,
        channelId: webhook.channelId,
      };
      delete state.goccRuns[normalizedJid];

      try {
        await utils.discord.getOrCreateChannel(normalizedJid);
        await storage.save();
      } catch (err) {
        state.logger?.error(err);
        if (previousChat) {
          state.chats[normalizedJid] = previousChat;
        } else {
          delete state.chats[normalizedJid];
        }
        if (previousRun) {
          state.goccRuns[normalizedJid] = previousRun;
        } else {
          delete state.goccRuns[normalizedJid];
        }
        if (forcedTakeover) {
          if (displacedChat) {
            state.chats[existingJid] = displacedChat;
          }
          if (displacedRun) {
            state.goccRuns[existingJid] = displacedRun;
          }
        }
        await ctx.reply('Linked the channel, but failed to finalize the setup. Please try again.');
        return;
      }

      if (previousChannelId && previousChannelId !== channel.id && previousChat?.id) {
        try {
          const previousChannel = await utils.discord.getChannel(previousChannelId);
          const previousWebhooks = await previousChannel?.fetchWebhooks();
          const previousWebhook = previousWebhooks?.get(previousChat.id) || previousWebhooks?.find((hook) => hook.id === previousChat.id);
          await previousWebhook?.delete('WA2DC channel relinked');
        } catch (err) {
          state.logger?.warn(err);
        }
      }

      const forcedSuffix = forcedTakeover
        ? ` (overrode the previous link to \`${utils.whatsapp.jidToName(existingJid)}\`).`
        : '.';
      await ctx.reply(`Linked ${channel} with \`${utils.whatsapp.jidToName(normalizedJid)}\`${forcedSuffix}`);
    },
  },
  move: {
    description: 'Move a WhatsApp link from one channel to another.',
    options: [
      {
        name: 'from',
        description: 'Current channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'to',
        description: 'Destination channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'force',
        description: 'Override any existing link on the destination.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const source = ctx.getChannelOption('from');
      const target = ctx.getChannelOption('to');
      const force = Boolean(ctx.getBooleanOption('force'));

      if (!source || !target) {
        await ctx.reply('Please mention the current channel and the new channel. Usage: `move #old-channel #new-channel` (enable the force option to override existing links)');
        return;
      }

      if (source.id === target.id) {
        await ctx.reply('Please mention two different channels to move between.');
        return;
      }

      if (source.id === state.settings.ControlChannelID || target.id === state.settings.ControlChannelID) {
        await ctx.reply('The control channel cannot participate in moves. Choose two regular text channels.');
        return;
      }

      if (source.guildId !== state.settings.GuildID || target.guildId !== state.settings.GuildID) {
        await ctx.reply('Please choose channels from the configured Discord server.');
        return;
      }

      if (!['GUILD_TEXT', 'GUILD_NEWS'].includes(target.type)) {
        await ctx.reply('Only text or announcement channels can be targets. Please choose a different channel.');
        return;
      }

      const sourceJidRaw = utils.discord.channelIdToJid(source.id);
      const normalizedJid = utils.whatsapp.formatJid(sourceJidRaw);
      if (!normalizedJid) {
        await ctx.reply('The source channel is not linked to any WhatsApp conversation.');
        return;
      }

      const existingTargetJid = utils.discord.channelIdToJid(target.id);
      const forcedTakeover = Boolean(existingTargetJid && existingTargetJid !== normalizedJid && force);
      let displacedChat;
      let displacedRun;
      if (existingTargetJid && existingTargetJid !== normalizedJid) {
        if (!force) {
          await ctx.reply('That destination channel is already linked to another conversation. Enable the force option to override it.');
          return;
        }
        displacedChat = state.chats[existingTargetJid];
        displacedRun = state.goccRuns[existingTargetJid];
        delete state.chats[existingTargetJid];
        delete state.goccRuns[existingTargetJid];
      }

      let webhook;
      try {
        const webhooks = await target.fetchWebhooks();
        webhook = webhooks.find((hook) => hook.token && hook.owner?.id === client.user.id);
        if (!webhook) {
          webhook = await target.createWebhook('WA2DC');
        }
      } catch (err) {
        state.logger?.error(err);
        if (forcedTakeover) {
          if (displacedChat) {
            state.chats[existingTargetJid] = displacedChat;
          }
          if (displacedRun) {
            state.goccRuns[existingTargetJid] = displacedRun;
          }
        }
        await ctx.reply('Failed to access or create a webhook for the destination channel. Check the bot\'s permissions.');
        return;
      }

      const previousChat = state.chats[normalizedJid];
      const previousRun = state.goccRuns[normalizedJid];
      state.chats[normalizedJid] = {
        id: webhook.id,
        type: webhook.type,
        token: webhook.token,
        channelId: webhook.channelId,
      };
      delete state.goccRuns[normalizedJid];

      try {
        await utils.discord.getOrCreateChannel(normalizedJid);
        await storage.save();
      } catch (err) {
        state.logger?.error(err);
        if (previousChat) {
          state.chats[normalizedJid] = previousChat;
        } else {
          delete state.chats[normalizedJid];
        }
        if (previousRun) {
          state.goccRuns[normalizedJid] = previousRun;
        } else {
          delete state.goccRuns[normalizedJid];
        }
        if (forcedTakeover) {
          if (displacedChat) {
            state.chats[existingTargetJid] = displacedChat;
          }
          if (displacedRun) {
            state.goccRuns[existingTargetJid] = displacedRun;
          }
        }
        await ctx.reply('Moved the channel, but failed to finalize the setup. Please try again.');
        return;
      }

      if (previousChat?.channelId && previousChat.channelId !== webhook.channelId && previousChat.id) {
        try {
          const previousChannel = await utils.discord.getChannel(previousChat.channelId);
          const previousWebhooks = await previousChannel?.fetchWebhooks();
          const previousWebhook = previousWebhooks?.get(previousChat.id) || previousWebhooks?.find((hook) => hook.id === previousChat.id);
          await previousWebhook?.delete('WA2DC channel moved');
        } catch (err) {
          state.logger?.warn(err);
        }
      }

      const forcedSuffix = forcedTakeover
        ? ` (overrode the previous link to \`${utils.whatsapp.jidToName(existingTargetJid)}\`).`
        : '.';
      await ctx.reply(
        `Moved \`${utils.whatsapp.jidToName(normalizedJid)}\` from ${source} to ${target}${forcedSuffix}`,
      );
    },
  },
  list: {
    description: 'List contacts and groups.',
    options: [
      {
        name: 'query',
        description: 'Optional search text.',
        type: ApplicationCommandOptionTypes.STRING,
        required: false,
      },
    ],
    async execute(ctx) {
      let contacts = utils.whatsapp.contacts();
      const query = ctx.getStringOption('query')?.toLowerCase();
      if (query) { contacts = contacts.filter((name) => name.toLowerCase().includes(query)); }
      contacts = contacts.sort((a, b) => a.localeCompare(b)).join('\n');
      const message = utils.discord.partitionText(
        contacts.length
          ? `${contacts}\n\nNot the whole list? You can refresh your contacts by typing \`resync\``
          : 'No results were found.',
      );
      while (message.length !== 0) {
        // eslint-disable-next-line no-await-in-loop
        await ctx.reply(message.shift());
      }
    },
  },
  linkmention: {
    description: 'Link a WhatsApp contact to a Discord user so WhatsApp @mentions ping them in Discord.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'user',
        description: 'Target Discord user to mention.',
        type: ApplicationCommandOptionTypes.USER,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      const user = ctx.getUserOption('user');
      if (!contact || !user?.id) {
        await ctx.reply('Usage: `/linkmention contact:<name or number> user:<@user>`.');
        return;
      }

      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`Couldn't find \`${contact}\`.`);
        return;
      }

      const formatted = utils.whatsapp.formatJid(jid);

      if (!state.settings.WhatsAppDiscordMentionLinks || typeof state.settings.WhatsAppDiscordMentionLinks !== 'object') {
        state.settings.WhatsAppDiscordMentionLinks = {};
      }
      state.settings.WhatsAppDiscordMentionLinks[formatted] = user.id;

      await storage.saveSettings().catch(() => {});

      const name = utils.whatsapp.jidToName(formatted);
      const displayJid = utils.whatsapp.formatJidForDisplay(formatted);
      await ctx.reply(`Linked WhatsApp contact **${name}** (${displayJid}) to <@${user.id}>.`);
    },
  },
  unlinkmention: {
    description: 'Remove a WhatsApp→Discord mention link for a contact.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      if (!contact) {
        await ctx.reply('Usage: `/unlinkmention contact:<name or number>`.');
        return;
      }

      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`Couldn't find \`${contact}\`.`);
        return;
      }

      const formatted = utils.whatsapp.formatJid(jid);

      const links = state.settings?.WhatsAppDiscordMentionLinks;
      if (!links || typeof links !== 'object') {
        await ctx.reply('No mention links are currently configured.');
        return;
      }

      let removed = 0;
      for (const key of Object.keys(links)) {
        if (utils.whatsapp.formatJid(key) !== formatted) continue;
        if (Object.prototype.hasOwnProperty.call(links, key)) {
          delete links[key];
          removed += 1;
        }
      }

      await storage.saveSettings().catch(() => {});

      const name = utils.whatsapp.jidToName(formatted);
      const displayJid = utils.whatsapp.formatJidForDisplay(formatted);
      if (!removed) {
        await ctx.reply(`No mention link found for **${name}** (${displayJid}).`);
        return;
      }
      await ctx.reply(`Removed mention link for **${name}** (${displayJid}).`);
    },
  },
  mentionlinks: {
    description: 'List WhatsApp contacts linked to Discord mentions.',
    async execute(ctx) {
      const links = state.settings?.WhatsAppDiscordMentionLinks;
      if (!links || typeof links !== 'object' || !Object.keys(links).length) {
        await ctx.reply('No mention links are currently configured.');
        return;
      }

      const byDiscordId = new Map();
      const isDiscordId = (value) => typeof value === 'string' && /^\d+$/.test(value.trim());

      for (const [jid, discordIdRaw] of Object.entries(links)) {
        const discordId = typeof discordIdRaw === 'string' ? discordIdRaw.trim() : '';
        if (!jid || !isDiscordId(discordId)) continue;
        const normalizedJid = utils.whatsapp.formatJid(jid) || jid;
        const existing = byDiscordId.get(discordId) || new Set();
        existing.add(normalizedJid);
        byDiscordId.set(discordId, existing);
      }

      if (!byDiscordId.size) {
        await ctx.reply('No valid mention links are currently configured.');
        return;
      }

      const lines = [];
      for (const [discordId, jids] of byDiscordId.entries()) {
        const jidList = [...jids].filter(Boolean);
        const preferred = state.settings?.HidePhoneNumbers
          ? (jidList.find((jid) => !utils.whatsapp.isPhoneJid(jid)) || jidList[0])
          : (jidList.find((jid) => utils.whatsapp.isPhoneJid(jid)) || jidList[0]);
        const name = preferred ? utils.whatsapp.jidToName(preferred) : 'Unknown';
        const displayJid = preferred ? utils.whatsapp.formatJidForDisplay(preferred) : 'Unknown';
        const suffix = jidList.length > 1 ? ` (aliases: ${jidList.length})` : '';
        lines.push(`- **${name}** (${displayJid})${suffix} -> <@${discordId}>`);
      }

      await ctx.replyPartitioned(lines.join('\n'));
    },
  },
  jidinfo: {
    description: 'Show known WhatsApp JID variants (PN/LID) for a contact and whether they are linked for mentions.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      if (!contact) {
        await ctx.reply('Usage: `/jidinfo contact:<name or number>`.');
        return;
      }

      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`Couldn't find \`${contact}\`.`);
        return;
      }

      const formatted = utils.whatsapp.formatJid(jid);
      const name = utils.whatsapp.jidToName(formatted);
      const normalizedName = String(name || '')
        .trim()
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ');

      const isSameName = (value) => {
        if (typeof value !== 'string') return false;
        const normalized = value
          .trim()
          .normalize('NFKC')
          .toLowerCase()
          .replace(/\s+/g, ' ');
        return normalized && normalized === normalizedName;
      };

      const candidates = new Set([formatted]);
      const addIfMatch = (jidCandidate, storedName) => {
        if (!jidCandidate) return;
        if (!isSameName(storedName)) return;
        const normalized = utils.whatsapp.formatJid(jidCandidate);
        if (normalized) candidates.add(normalized);
      };

      for (const [jidCandidate, storedName] of Object.entries(state.contacts || {})) {
        addIfMatch(jidCandidate, storedName);
      }
      for (const [jidCandidate, storedName] of Object.entries(state.waClient?.contacts || {})) {
        addIfMatch(jidCandidate, storedName);
      }

      const links = state.settings?.WhatsAppDiscordMentionLinks;
      const linkEntries = [];
      if (links && typeof links === 'object') {
        for (const [linkJid, discordIdRaw] of Object.entries(links)) {
          const normalizedLinkJid = utils.whatsapp.formatJid(linkJid);
          if (!normalizedLinkJid) continue;
          if (!candidates.has(normalizedLinkJid)) continue;
          linkEntries.push({
            key: linkJid,
            jid: normalizedLinkJid,
            discordId: typeof discordIdRaw === 'string' ? discordIdRaw.trim() : '',
          });
        }
      }

      const classify = (jidValue) => {
        if (utils.whatsapp.isPhoneJid(jidValue)) return 'PN';
        if (utils.whatsapp.isLidJid(jidValue)) return 'LID';
        if (typeof jidValue === 'string' && jidValue.endsWith('@g.us')) return 'GROUP';
        return 'OTHER';
      };

      const jidList = [...candidates].filter(Boolean).sort((a, b) => a.localeCompare(b));
      const lines = [];
      lines.push(`Contact: **${name}**`);
      lines.push(`Resolved: \`${utils.whatsapp.formatJidForDisplay(formatted)}\` (${classify(formatted)})`);
      lines.push('Known JIDs:');
      for (const jidValue of jidList) {
        const linked = linkEntries.filter((entry) => entry.jid === jidValue && /^\d+$/.test(entry.discordId));
        const linkSuffix = linked.length
          ? ` -> ${linked.map((entry) => `<@${entry.discordId}>`).join(', ')}`
          : '';
        lines.push(`- \`${utils.whatsapp.formatJidForDisplay(jidValue)}\` (${classify(jidValue)})${linkSuffix}`);
      }
      if (linkEntries.length) {
        lines.push('Raw mention-link keys:');
        for (const entry of linkEntries) {
          const suffix = /^\d+$/.test(entry.discordId) ? ` -> <@${entry.discordId}>` : '';
          lines.push(`- \`${utils.whatsapp.formatJidForDisplay(entry.key)}\`${suffix}`);
        }
      }

      await ctx.replyPartitioned(lines.join('\n'));
    },
  },
  addtowhitelist: {
    description: 'Add a channel to the whitelist.',
    options: [
      {
        name: 'channel',
        description: 'Channel linked to a WhatsApp chat.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
    ],
    async execute(ctx) {
      const channel = ctx.getChannelOption('channel');
      if (!channel) {
        await ctx.reply('Please enter a valid channel name. Usage: `addToWhitelist #<target channel>`.');
        return;
      }

      const jid = utils.discord.channelIdToJid(channel.id);
      if (!jid) {
        await ctx.reply("Couldn't find a chat with the given channel.");
        return;
      }

      const normalized = utils.whatsapp.formatJid(jid);
      if (normalized && !state.settings.Whitelist.includes(normalized)) {
        state.settings.Whitelist.push(normalized);
      }
      await ctx.reply('Added to the whitelist!');
    },
  },
  removefromwhitelist: {
    description: 'Remove a channel from the whitelist.',
    options: [
      {
        name: 'channel',
        description: 'Channel linked to a WhatsApp chat.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
    ],
    async execute(ctx) {
      const channel = ctx.getChannelOption('channel');
      if (!channel) {
        await ctx.reply('Please enter a valid channel name. Usage: `removeFromWhitelist #<target channel>`.');
        return;
      }

      const jid = utils.discord.channelIdToJid(channel.id);
      if (!jid) {
        await ctx.reply("Couldn't find a chat with the given channel.");
        return;
      }

      const normalized = utils.whatsapp.formatJid(jid);
      state.settings.Whitelist = state.settings.Whitelist.filter((el) => el !== normalized);
      await ctx.reply('Removed from the whitelist!');
    },
  },
  listwhitelist: {
    description: 'List whitelisted channels.',
    async execute(ctx) {
      await ctx.reply(
        state.settings.Whitelist.length
          ? `\`\`\`${state.settings.Whitelist.map((jid) => utils.whatsapp.jidToName(jid)).join('\n')}\`\`\``
          : 'Whitelist is empty/inactive.',
      );
    },
  },
  setdcprefix: {
    description: 'Set a static prefix for Discord messages.',
    options: [
      {
        name: 'prefix',
        description: 'Prefix text. Leave empty to reset to username.',
        type: ApplicationCommandOptionTypes.STRING,
        required: false,
      },
    ],
    async execute(ctx) {
      const prefix = ctx.getStringOption('prefix');
      if (prefix) {
        state.settings.DiscordPrefixText = prefix;
        await ctx.reply(`Discord prefix is set to ${prefix}!`);
      } else {
        state.settings.DiscordPrefixText = null;
        await ctx.reply('Discord prefix is set to your discord username!');
      }
    },
  },
  dcprefix: {
    description: 'Toggle Discord username prefixes.',
    options: [
      {
        name: 'enabled',
        description: 'Whether Discord username prefixes should be used.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.DiscordPrefix = enabled;
      await ctx.reply(`Discord username prefix is set to ${state.settings.DiscordPrefix}.`);
    },
  },
  waprefix: {
    description: 'Toggle WhatsApp name prefixes on Discord.',
    options: [
      {
        name: 'enabled',
        description: 'Whether WhatsApp sender names should be prepended inside Discord messages.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.WAGroupPrefix = enabled;
      await ctx.reply(`WhatsApp name prefix is set to ${state.settings.WAGroupPrefix}.`);
    },
  },
  waplatformsuffix: {
    description: 'Toggle WhatsApp sender platform suffix on Discord.',
    options: [
      {
        name: 'enabled',
        description: 'Whether WhatsApp messages mirrored to Discord should include a sender platform suffix.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.WASenderPlatformSuffix = enabled;
      await ctx.reply(`WhatsApp sender platform suffix is set to ${state.settings.WASenderPlatformSuffix}.`);
    },
  },
  hidephonenumbers: {
    description: 'Hide WhatsApp phone numbers on Discord (use pseudonyms when needed).',
    options: [
      {
        name: 'enabled',
        description: 'Whether phone numbers should be hidden on Discord.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.HidePhoneNumbers = enabled;
      if (enabled) {
        utils.whatsapp.ensurePrivacySalt();
      }
      await ctx.reply(`Hide phone numbers is set to ${state.settings.HidePhoneNumbers}.`);
    },
  },
  waupload: {
    description: 'Toggle uploading attachments to WhatsApp.',
    options: [
      {
        name: 'enabled',
        description: 'Whether Discord attachments should be uploaded to WhatsApp (vs sending as links).',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.UploadAttachments = enabled;
      await ctx.reply(`Uploading attachments to WhatsApp is set to ${state.settings.UploadAttachments}.`);
    },
  },
  deletes: {
    description: 'Toggle mirrored message deletions.',
    options: [
      {
        name: 'enabled',
        description: 'Whether message deletions should be mirrored between Discord and WhatsApp.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.DeleteMessages = enabled;
      await ctx.reply(`Mirrored message deletions are set to ${state.settings.DeleteMessages}.`);
    },
  },
  readreceipts: {
    description: 'Toggle read receipts.',
    options: [
      {
        name: 'enabled',
        description: 'Whether read receipts are enabled.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.ReadReceipts = enabled;
      await ctx.reply(`Read receipts are set to ${state.settings.ReadReceipts}.`);
    },
  },
  dmreadreceipts: {
    description: 'Send read receipts via DM.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'dm';
      await ctx.reply('Read receipts will be sent via DM.');
    },
  },
  publicreadreceipts: {
    description: 'Send read receipts as channel replies.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'public';
      await ctx.reply('Read receipts will be posted publicly.');
    },
  },
  reactionreadreceipts: {
    description: 'Send read receipts as reactions.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'reaction';
      await ctx.reply('Read receipts will be added as ☑️ reactions.');
    },
  },
  help: {
    description: 'Show help link.',
    async execute(ctx) {
      await ctx.reply('See all the available commands at https://arespawn.github.io/WhatsAppToDiscord/#/commands');
    },
  },
  resync: {
    description: 'Re-sync WhatsApp contacts and groups.',
    options: [
      {
        name: 'rename',
        description: 'Rename channels to match WhatsApp names.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      await ctx.defer();
      await state.waClient.authState.keys.set({
        'app-state-sync-version': { critical_unblock_low: null },
      });
      await state.waClient.resyncAppState(['critical_unblock_low']);
      const participatingGroups = await state.waClient.groupFetchAllParticipating();
      groupMetadataCache.prime(participatingGroups);
      for (const [jid, attributes] of Object.entries(participatingGroups)) {
        state.waClient.contacts[jid] = attributes.subject;
      }
      const shouldRename = Boolean(ctx.getBooleanOption('rename'));
      if (shouldRename) {
        try {
          await utils.discord.renameChannels();
        } catch (err) {
          state.logger?.error(err);
        }
      }
      await ctx.reply('Re-synced!');
    },
  },
  localdownloads: {
    description: 'Toggle local downloads for large files.',
    options: [
      {
        name: 'enabled',
        description: 'Whether large WhatsApp attachments should be downloaded locally.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.LocalDownloads = enabled;
      await ctx.reply(`Local downloads are set to ${state.settings.LocalDownloads}.`);
    },
  },
  getdownloadmessage: {
    description: 'Show the current download message template.',
    async execute(ctx) {
      await ctx.reply(`Download message format is set to "${state.settings.LocalDownloadMessage}"`);
    },
  },
  setdownloadmessage: {
    description: 'Update the download message template.',
    options: [
      {
        name: 'message',
        description: 'Template text.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const message = ctx.getStringOption('message');
      state.settings.LocalDownloadMessage = message;
      await ctx.reply(`Set download message format to "${state.settings.LocalDownloadMessage}"`);
    },
  },
  getdownloaddir: {
    description: 'Show the download directory.',
    async execute(ctx) {
      await ctx.reply(`Download path is set to "${state.settings.DownloadDir}"`);
    },
  },
  setdownloaddir: {
    description: 'Set the download directory.',
    options: [
      {
        name: 'path',
        description: 'Directory path for downloads.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const dir = ctx.getStringOption('path');
      state.settings.DownloadDir = dir;
      await ctx.reply(`Set download path to "${state.settings.DownloadDir}"`);
    },
  },
  setdownloadlimit: {
    description: 'Set the local download directory size limit in GB.',
    options: [
      {
        name: 'size',
        description: 'Size limit in gigabytes.',
        type: ApplicationCommandOptionTypes.NUMBER,
        required: true,
      },
    ],
    async execute(ctx) {
      const gb = ctx.getNumberOption('size');
      if (!Number.isNaN(gb) && gb >= 0) {
        state.settings.DownloadDirLimitGB = gb;
        await ctx.reply(`Set download directory size limit to ${gb} GB.`);
      } else {
        await ctx.reply('Please provide a valid size in gigabytes.');
      }
    },
  },
  setfilesizelimit: {
    description: 'Set the Discord upload size limit used by the bot.',
    options: [
      {
        name: 'bytes',
        description: 'Maximum size in bytes.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const size = ctx.getIntegerOption('bytes');
      if (!Number.isNaN(size) && size > 0) {
        state.settings.DiscordFileSizeLimit = size;
        await ctx.reply(`Set Discord file size limit to ${size} bytes.`);
      } else {
        await ctx.reply('Please provide a valid size in bytes.');
      }
    },
  },
  localdownloadserver: {
    description: 'Toggle the local download server.',
    options: [
      {
        name: 'enabled',
        description: 'Whether the local download server should be running.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.LocalDownloadServer = enabled;
      if (enabled) {
        utils.ensureDownloadServer();
        await ctx.reply(`Local download server is set to true (port ${state.settings.LocalDownloadServerPort}).`);
        return;
      }

      utils.stopDownloadServer();
      await ctx.reply('Local download server is set to false.');
    },
  },
  setlocaldownloadserverport: {
    description: 'Set the download server port.',
    options: [
      {
        name: 'port',
        description: 'Port number.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const port = ctx.getIntegerOption('port');
      if (!Number.isNaN(port) && port > 0 && port <= 65535) {
        state.settings.LocalDownloadServerPort = port;
        utils.stopDownloadServer();
        utils.ensureDownloadServer();
        await ctx.reply(`Set local download server port to ${port}.`);
      } else {
        await ctx.reply('Please provide a valid port.');
      }
    },
  },
  setlocaldownloadserverhost: {
    description: 'Set the download server host.',
    options: [
      {
        name: 'host',
        description: 'Hostname or IP for the download server.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const host = ctx.getStringOption('host');
      state.settings.LocalDownloadServerHost = host;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`Set local download server host to ${host}.`);
    },
  },
  setlocaldownloadserverbindhost: {
    description: 'Set the download server bind/listen host.',
    options: [
      {
        name: 'host',
        description: 'Bind host (e.g., 127.0.0.1 or 0.0.0.0).',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const host = ctx.getStringOption('host');
      state.settings.LocalDownloadServerBindHost = host;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`Set local download server bind host to ${host}.`);
    },
  },
  setdownloadlinkttl: {
    description: 'Set local download link expiry in seconds (0 = never).',
    options: [
      {
        name: 'seconds',
        description: 'Seconds until links expire.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const seconds = ctx.getIntegerOption('seconds');
      if (!Number.isNaN(seconds) && seconds >= 0) {
        state.settings.LocalDownloadLinkTTLSeconds = seconds;
        await ctx.reply(`Set local download link TTL to ${seconds} seconds.`);
      } else {
        await ctx.reply('Please provide a valid number of seconds (0 or higher).');
      }
    },
  },
  setdownloadmaxage: {
    description: 'Set max age (days) for files in the download directory (0 = keep forever).',
    options: [
      {
        name: 'days',
        description: 'Maximum age in days.',
        type: ApplicationCommandOptionTypes.NUMBER,
        required: true,
      },
    ],
    async execute(ctx) {
      const days = ctx.getNumberOption('days');
      if (!Number.isNaN(days) && days >= 0) {
        state.settings.DownloadDirMaxAgeDays = days;
        await ctx.reply(`Set download directory max age to ${days} day(s).`);
      } else {
        await ctx.reply('Please provide a valid number of days (0 or higher).');
      }
    },
  },
  setdownloadminfree: {
    description: 'Set minimum free disk space (GB) to keep by pruning downloads (0 = disabled).',
    options: [
      {
        name: 'gb',
        description: 'Minimum free space in gigabytes.',
        type: ApplicationCommandOptionTypes.NUMBER,
        required: true,
      },
    ],
    async execute(ctx) {
      const gb = ctx.getNumberOption('gb');
      if (!Number.isNaN(gb) && gb >= 0) {
        state.settings.DownloadDirMinFreeGB = gb;
        await ctx.reply(`Set download directory minimum free space to ${gb} GB.`);
      } else {
        await ctx.reply('Please provide a valid size in gigabytes (0 or higher).');
      }
    },
  },
  httpsdownloadserver: {
    description: 'Toggle HTTPS for the local download server.',
    options: [
      {
        name: 'enabled',
        description: 'Whether HTTPS should be enabled for the local download server.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.UseHttps = enabled;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`HTTPS for local download server is set to ${state.settings.UseHttps}.`);
    },
  },
  sethttpscert: {
    description: 'Set HTTPS certificate paths for the download server.',
    options: [
      {
        name: 'key_path',
        description: 'Path to the TLS key.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'cert_path',
        description: 'Path to the TLS certificate.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const key = ctx.getStringOption('key_path');
      const cert = ctx.getStringOption('cert_path');
      [state.settings.HttpsKeyPath, state.settings.HttpsCertPath] = [key, cert];
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`Set HTTPS key path to ${key} and cert path to ${cert}.`);
    },
  },
  publishing: {
    description: 'Toggle publishing messages in news channels automatically.',
    options: [
      {
        name: 'enabled',
        description: 'Whether messages sent to news channels should be cross-posted automatically.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.Publish = enabled;
      await ctx.reply(`Publishing messages in news channels is set to ${state.settings.Publish}.`);
    },
  },
  changenotifications: {
    description: 'Toggle profile/status change notifications (and WhatsApp Status mirroring).',
    options: [
      {
        name: 'enabled',
        description: 'Whether change notifications and WhatsApp Status mirroring are enabled.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.ChangeNotifications = enabled;
      state.settings.MirrorWAStatuses = enabled;
      await ctx.reply(`Change notifications are set to ${state.settings.ChangeNotifications}.`);
    },
  },
  autosaveinterval: {
    description: 'Set the auto-save interval (seconds).',
    options: [
      {
        name: 'seconds',
        description: 'Number of seconds between saves.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const seconds = ctx.getIntegerOption('seconds');
      state.settings.autoSaveInterval = seconds;
      await ctx.reply(`Changed auto save interval to ${seconds}.`);
    },
  },
  lastmessagestorage: {
    description: 'Set how many recent messages can be edited/deleted.',
    options: [
      {
        name: 'size',
        description: 'Number of messages to keep.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const size = ctx.getIntegerOption('size');
      state.settings.lastMessageStorage = size;
      await ctx.reply(`Changed last message storage size to ${size}.`);
    },
  },
  oneway: {
    description: 'Set one-way communication mode.',
    options: [
      {
        name: 'direction',
        description: 'Choose direction or disable one-way.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
        choices: [
          { name: 'discord', value: 'discord' },
          { name: 'whatsapp', value: 'whatsapp' },
          { name: 'disabled', value: 'disabled' },
        ],
      },
    ],
    async execute(ctx) {
      const direction = ctx.getStringOption('direction');

      if (direction === 'disabled') {
        state.settings.oneWay = 0b11;
        await ctx.reply('Two way communication is enabled.');
      } else if (direction === 'whatsapp') {
        state.settings.oneWay = 0b10;
        await ctx.reply('Messages will be only sent to WhatsApp.');
      } else if (direction === 'discord') {
        state.settings.oneWay = 0b01;
        await ctx.reply('Messages will be only sent to Discord.');
      }
    },
  },
  redirectbots: {
    description: 'Toggle redirecting bot messages to WhatsApp.',
    options: [
      {
        name: 'enabled',
        description: 'Whether bot messages should be redirected.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.redirectBots = enabled;
      await ctx.reply(`Redirecting bots is set to ${state.settings.redirectBots}.`);
    },
  },
  redirectwebhooks: {
    description: 'Toggle redirecting webhook messages to WhatsApp.',
    options: [
      {
        name: 'enabled',
        description: 'Whether webhook messages should be redirected.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.redirectWebhooks = enabled;
      await ctx.reply(`Redirecting webhooks is set to ${state.settings.redirectWebhooks}.`);
    },
  },
  restart: {
    description: 'Restart the bot safely.',
    async execute(ctx) {
      if (!ctx.isControlChannel) {
        await ctx.reply('For safety, `/restart` can only be used in the control channel.');
        return;
      }

      await requestSafeRestart(ctx, { message: 'Saved state. Restarting...' });
    },
  },
  updatechannel: {
    description: 'Switch update channel between stable and unstable.',
    options: [
      {
        name: 'channel',
        description: 'Release channel.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
        choices: [
          { name: 'stable', value: 'stable' },
          { name: 'unstable', value: 'unstable' },
        ],
      },
    ],
    async execute(ctx) {
      const channel = ctx.getStringOption('channel');

      state.settings.UpdateChannel = channel;
      await ctx.reply(`Update channel set to ${channel}. Checking for new releases...`);
      await utils.updater.run(state.version, { prompt: false });
      await utils.discord.syncUpdatePrompt();
      await utils.discord.syncRollbackPrompt();
      if (state.updateInfo) {
        const message = utils.updater.formatUpdateMessage(state.updateInfo);
        await ctx.replyPartitioned(message);
      } else {
        await ctx.reply('No updates are available on that channel right now.');
      }
    },
  },
  update: {
    description: 'Install the available update.',
    async execute(ctx) {
      await ctx.defer();
      if (!state.updateInfo) {
        await ctx.reply('No update available.');
        return;
      }
      if (!state.updateInfo.canSelfUpdate) {
        await ctx.replyPartitioned(
          `A new ${state.updateInfo.channel || 'stable'} release (${state.updateInfo.version}) is available, but this installation cannot self-update.\n` +
          'Pull the new image or binary for the requested release and restart the bot.',
        );
        return;
      }

      await ctx.reply('Updating...');
      const success = await utils.updater.update(state.updateInfo.version);
      if (!success) {
        await ctx.reply('Update failed. Check logs.');
        return;
      }

      state.updateInfo = null;
      await utils.discord.syncUpdatePrompt();
      await utils.discord.syncRollbackPrompt();
      await requestSafeRestart(ctx, { message: 'Update downloaded. Restarting...' });
    },
  },
  checkupdate: {
    description: 'Check for updates now.',
    async execute(ctx) {
      await ctx.defer();
      await utils.updater.run(state.version, { prompt: false });
      await utils.discord.syncUpdatePrompt();
      await utils.discord.syncRollbackPrompt();
      if (state.updateInfo) {
        const message = utils.updater.formatUpdateMessage(state.updateInfo);
        const components = [
          new MessageActionRow().addComponents(
            new MessageButton()
              .setCustomId(UPDATE_BUTTON_IDS.APPLY)
              .setLabel('Update')
              .setStyle('PRIMARY')
              .setDisabled(!state.updateInfo.canSelfUpdate),
            new MessageButton()
              .setCustomId(UPDATE_BUTTON_IDS.SKIP)
              .setLabel('Skip update')
              .setStyle('SECONDARY'),
          ),
        ];
        await ctx.reply({ content: message, components });
      } else {
        await ctx.reply('No update available.');
      }
    },
  },
  skipupdate: {
    description: 'Clear the current update notification.',
    async execute(ctx) {
      state.updateInfo = null;
      await utils.discord.syncUpdatePrompt();
      await utils.discord.syncRollbackPrompt();
      await ctx.reply('Update skipped.');
    },
  },
  rollback: {
    description: 'Roll back to the previous packaged binary.',
    async execute(ctx) {
      await ctx.defer();
      const result = await utils.updater.rollback();
      if (result.success) {
        await utils.discord.syncRollbackPrompt();
        await requestSafeRestart(ctx, { message: 'Rolled back to the previous packaged binary. Restarting...' });
        return;
      }

      if (result.reason === 'node') {
        await ctx.replyPartitioned(
          'Rollback is only available for packaged binaries. To roll back a Docker or source install, pull the previous image/tag and restart.'
        );
        return;
      }

      if (result.reason === 'no-backup') {
        await ctx.reply('No previous packaged binary is available to roll back to.');
        return;
      }

      await ctx.reply('Rollback failed. Check logs for details.');
    },
  },
  unknown: {
    register: false,
    async execute(ctx) {
      await ctx.reply('Unknown command.');
    },
  },
};

const slashCommands = Object.entries(commandHandlers)
  .filter(([, def]) => def.register !== false)
  .map(([name, def]) => ({
    name,
    description: def.description || 'No description provided.',
    options: def.options || [],
  }));

const buildInviteLink = () => (
  client?.user?.id
    ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`
    : null
);

const registerSlashCommands = async () => {
  try {
    const guild = await utils.discord.getGuild();
    if (!guild) {
      state.logger?.error('Failed to load guild while registering commands.');
      return;
    }
    await guild.commands.set(slashCommands);
  } catch (err) {
    state.logger?.error({ err }, 'Failed to register slash commands');
    const missingAccess = err?.code === 50001 || /Missing Access/i.test(err?.message || '');
    if (missingAccess && !slashRegisterWarned) {
      slashRegisterWarned = true;
      const link = buildInviteLink();
      const warning = link
        ? `Slash commands could not be registered (missing applications.commands scope). Re-invite the bot with this link:\n${link}`
        : 'Slash commands could not be registered (missing applications.commands scope). Re-invite the bot with both bot and applications.commands scopes.';
      controlChannel?.send(warning).catch(() => {});
    }
  }
};

const executeCommand = async (name, ctx) => {
  const handler = commandHandlers[name] || commandHandlers.unknown;
  await handler.execute(ctx);
};

const handleInteractionCommand = async (interaction, commandName) => {
  const responder = new CommandResponder({ interaction, channel: interaction.channel });
  await responder.defer();
  const ctx = new CommandContext({ interaction, responder });
  await executeCommand(commandName, ctx);
};

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === UPDATE_BUTTON_IDS.APPLY) {
      await handleInteractionCommand(interaction, 'update');
      return;
    }
    if (interaction.customId === UPDATE_BUTTON_IDS.SKIP) {
      await handleInteractionCommand(interaction, 'skipupdate');
      return;
    }
    if (interaction.customId === ROLLBACK_BUTTON_ID) {
      await handleInteractionCommand(interaction, 'rollback');
      return;
    }
    return;
  }

  if (!interaction.isCommand?.() && !interaction.isChatInputCommand?.()) {
    return;
  }

  const commandName = interaction.commandName?.toLowerCase();
  await handleInteractionCommand(interaction, commandName);
});

client.on('raw', (packet = {}) => {
  if (packet.t !== 'MESSAGE_CREATE') {
    return;
  }

  const rawData = packet.d || {};
  const messageId = rawData.id ? String(rawData.id) : null;
  if (!messageId) {
    return;
  }

  const snapshots = Array.isArray(rawData.message_snapshots)
    ? rawData.message_snapshots
    : (Array.isArray(rawData.messageSnapshots) ? rawData.messageSnapshots : []);
  const reference = rawData.message_reference || rawData.messageReference || {};
  const sourceChannelId = reference.channel_id || reference.channelId || null;
  const sourceMessageId = reference.message_id || reference.messageId || null;
  const sourceGuildId = reference.guild_id || reference.guildId || null;
  const hasForwardSignal = snapshots.length > 0;
  const hasSourceReference = Boolean(sourceChannelId || sourceMessageId || sourceGuildId);
  const snapshot = extractForwardSnapshot(rawData);

  if (!hasForwardSignal && !hasSourceReference && !snapshot) {
    return;
  }

  setTimedCacheEntry(
    discordForwardContextCache,
    discordForwardContextTimers,
    messageId,
    {
      isForwarded: hasForwardSignal,
      sourceChannelId,
      sourceMessageId,
      sourceGuildId,
      snapshot,
    },
    DISCORD_FORWARD_CONTEXT_TTL_MS,
  );
});

client.on('messageCreate', async (message) => {
  const isWebhookMessage = message.webhookId != null;

  if (message.author === client.user || message.applicationId === client.user.id) {
    return;
  }

  if (isWebhookMessage) {
    if (!state.settings.redirectWebhooks) {
      return;
    }
  } else if (message.author?.bot && !state.settings.redirectBots) {
    return;
  }

  const messageType = typeof message.type === 'number' ? Constants.MessageTypes?.[message.type] : message.type;
  if (messageType === 'CHANNEL_PINNED_MESSAGE') {
    return;
  }

  if (message.channel.id === state.settings.ControlChannelID) {
    await message.channel.send('Regular commands have been removed. Please use Discord slash commands (/) instead.');
    return;
  }

  const jid = utils.discord.channelIdToJid(message.channel.id);
  if (jid == null) {
    return;
  }

  const rawForwardContext = consumeForwardContext(message.id);
  const forwardContext = buildForwardContext(message, rawForwardContext);
  const snapshot = rawForwardContext?.snapshot;
  if (snapshot) {
    message.wa2dcForwardSnapshot = snapshot;
  }
  state.waClient.ev.emit('discordMessage', { jid, message, forwardContext });
});

client.on('messageUpdate', async (oldMessage, message) => {
  const isWebhookMessage = message.webhookId != null;

  if (message.partial) {
    try {
      await message.fetch();
    } catch (err) {
      state.logger?.warn(err);
      return;
    }
  }

  const jid = utils.discord.channelIdToJid(message.channelId);
  if (jid == null) {
    return;
  }

  const oldPinned = typeof oldMessage?.pinned === 'boolean' ? oldMessage.pinned : undefined;
  const newPinned = Boolean(message.pinned);
  const pinChanged = typeof oldPinned === 'boolean' ? oldPinned !== newPinned : newPinned === true;

  if (pinChanged) {
    const waId = state.lastMessages[message.id];
    if (waId == null) {
      await message.channel.send(`Couldn't ${newPinned ? 'pin' : 'unpin'} on WhatsApp. You can only pin messages synced with WhatsApp.`);
    } else if (bridgePinnedMessages.has(message.id)) {
      bridgePinnedMessages.delete(message.id);
    } else {
      const stored = messageStore.get({ id: waId, remoteJid: jid });
      const key = stored?.key || { id: waId, remoteJid: jid, fromMe: stored?.key?.fromMe || false };
      const pinType = newPinned ? 1 : 0;
      try {
        state.sentPins.add(key.id);
        const sentPinMsg = await state.waClient.sendMessage(jid, {
          pin: key,
          type: pinType,
          ...(pinType === 1 ? { time: getPinDurationSeconds() } : {}),
        });
        const pinNoticeKey = sentPinMsg?.key
          ? {
              ...sentPinMsg.key,
              remoteJid: utils.whatsapp.formatJid(sentPinMsg.key.remoteJid || jid),
              participant: utils.whatsapp.formatJid(sentPinMsg.key.participant || sentPinMsg.key.participantAlt),
            }
          : null;
        if (pinNoticeKey?.id) {
          state.sentPins.add(pinNoticeKey.id);
        }
        if (newPinned) {
          schedulePinExpiryNotice(message, getPinDurationSeconds());
        } else {
          clearPinExpiryNotice(message.id);
        }
        setTimeout(() => state.sentPins.delete(key.id), 5 * 60 * 1000);
        if (pinNoticeKey?.id) {
          setTimeout(() => state.sentPins.delete(pinNoticeKey.id), 5 * 60 * 1000);
          try {
            await state.waClient.sendMessage(pinNoticeKey.remoteJid, { delete: pinNoticeKey });
          } catch (err) {
            state.logger?.debug?.({ err }, 'Failed to delete local pin notice');
          }
        }
      } catch (err) {
        state.logger?.error({ err }, 'Failed to sync Discord pin to WhatsApp');
      }
    }
  }

  if (message.editedTimestamp == null || isWebhookMessage) {
    return;
  }

  const messageId = state.lastMessages[message.id];
  if (messageId == null) {
    if (message.author?.bot && !state.settings.redirectBots) {
      return;
    }
    await message.channel.send(`Couldn't edit the message. You can only edit the last ${state.settings.lastMessageStorage} messages.`);
    return;
  }

  if ((message.content || '').trim() === '') {
    await message.channel.send('Edited message has no text to send to WhatsApp.');
    return;
  }

  state.waClient.ev.emit('discordEdit', { jid, message });
});

client.on('messageDelete', async (message) => {
  if (!state.settings.DeleteMessages) {
    return;
  }

  clearTimedCacheEntry(discordMessageLocationCache, discordMessageLocationTimers, message?.id);
  clearTimedCacheEntry(discordForwardContextCache, discordForwardContextTimers, message?.id);

  const jid = utils.discord.channelIdToJid(message.channelId);
  if (jid == null) {
    return;
  }

  const waIds = [];
  for (const [waId, dcId] of Object.entries(state.lastMessages)) {
    if (dcId === message.id && waId !== message.id) {
      waIds.push(waId);
    }
  }

  if (message.webhookId != null && waIds.length === 0) {
    return;
  }

  if (message.author?.bot && !state.settings.redirectBots && waIds.length === 0) {
    return;
  }

  if (message.author?.id === client.user.id) {
    return;
  }

  if (waIds.length === 0) {
    await message.channel.send(`Couldn't delete the message. You can only delete the last ${state.settings.lastMessageStorage} messages.`);
    return;
  }

  for (const waId of waIds) {
    state.waClient.ev.emit('discordDelete', { jid, id: waId });
    delete state.lastMessages[waId];
  }
  delete state.lastMessages[message.id];
  clearPinExpiryNotice(message.id);
});

client.on('messageReactionAdd', async (reaction, user) => {
  const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
  if (jid == null) {
    return;
  }
  const isBotUser = user?.id === state.dcClient?.user?.id;
  if (
    isBotUser
    && reaction.emoji?.name === '☑️'
    && (
      reaction.message.webhookId != null
      || deliveredMessages.has(reaction.message.id)
    )
  ) {
    return;
  }
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    if (reaction.message.webhookId == null && reaction.message.author?.bot && !state.settings.redirectBots) {
      return;
    }
    await reaction.message.channel.send(`Couldn't send the reaction. You can only react to last ${state.settings.lastMessageStorage} messages.`);
    return;
  }
  if (isBotUser) {
    return;
  }
  const selfJid = state.waClient?.user?.id && utils.whatsapp.formatJid(state.waClient.user.id);
  if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
    const prev = state.reactions[reaction.message.id][selfJid];
    await reaction.message.reactions.cache.get(prev)?.remove().catch(() => {});
    delete state.reactions[reaction.message.id][selfJid];
    if (!Object.keys(state.reactions[reaction.message.id]).length) {
      delete state.reactions[reaction.message.id];
    }
  }
  state.waClient.ev.emit('discordReaction', { jid, reaction, removed: false });
});

client.on('messageReactionRemove', async (reaction, user) => {
  const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
  if (jid == null) {
    return;
  }
  const isBotUser = user?.id === state.dcClient?.user?.id;
  if (
    isBotUser
    && reaction.emoji?.name === '☑️'
    && (
      reaction.message.webhookId != null
      || deliveredMessages.has(reaction.message.id)
    )
  ) {
    return;
  }
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    if (reaction.message.webhookId == null && reaction.message.author?.bot && !state.settings.redirectBots) {
      return;
    }
    await reaction.message.channel.send(`Couldn't remove the reaction. You can only react to last ${state.settings.lastMessageStorage} messages.`);
    return;
  }
  if (isBotUser) {
    return;
  }
  const selfJid = state.waClient?.user?.id && utils.whatsapp.formatJid(state.waClient.user.id);
  if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
    const prev = state.reactions[reaction.message.id][selfJid];
    await reaction.message.reactions.cache.get(prev)?.remove().catch(() => {});
    delete state.reactions[reaction.message.id][selfJid];
    if (!Object.keys(state.reactions[reaction.message.id]).length) {
      delete state.reactions[reaction.message.id];
    }
  }
  state.waClient.ev.emit('discordReaction', { jid, reaction, removed: true });
});

const discordHandler = {
  start: async () => {
    await client.login(state.settings.Token);
    return client;
  },
  setControlChannel,
};

export default discordHandler;
