import {
  DisconnectReason,
  getAggregateVotesInPollMessage,
  proto,
  updateMessageWithPollUpdate,
  WAMessageStatus,
  WAMessageStubType,
} from '@whiskeysockets/baileys';
import { decryptPollVote } from '@whiskeysockets/baileys/lib/Utils/process-message.js';
import { getKeyAuthor } from '@whiskeysockets/baileys/lib/Utils/generics.js';

import utils from './utils.js';
import state from './state.js';
import { createWhatsAppClient, getBaileysVersion } from './clientFactories.js';
import useSQLiteAuthState from './auth/sqliteAuthState.js';
import groupMetadataCache from './groupMetadataCache.js';
import messageStore from './messageStore.js';
import { createGroupRefreshScheduler } from './groupMetadataRefresh.js';
import { getPollEncKey, getPollOptions } from './pollUtils.js';
import { oneWayAllowsDiscordToWhatsApp } from './oneWay.js';
let authState;
let saveState;
let groupCachePruneInterval = null;
const allowsDiscordToWhatsApp = () => oneWayAllowsDiscordToWhatsApp(state.settings.oneWay);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatDisconnectReason = (statusCode) => {
    if (typeof statusCode !== 'number') return 'unknown';
    const label = DisconnectReason[statusCode];
    return label ? `${label} (${statusCode})` : `code ${statusCode}`;
};
const getReconnectDelayMs = (retry) => {
    if (retry <= 3) {
        return 0;
    }
    const slowAttempt = retry - 3;
    const baseDelay = 5000;
    const maxDelay = 60000;
    return Math.min(baseDelay * 2 ** (slowAttempt - 1), maxDelay);
};

const getPollCreation = (message = {}) => message.pollCreationMessage
    || message.pollCreationMessageV2
    || message.pollCreationMessageV3
    || message.pollCreationMessageV4;

const aggregatePoll = (pollMessage) => {
    if (!pollMessage) return [];
    const message = pollMessage.message || pollMessage;
    const pollUpdates = pollMessage.pollUpdates || [];
    return getAggregateVotesInPollMessage({ message, pollUpdates }, state.waClient?.user?.id);
};

const formatPollForDiscord = (pollMessage) => {
    const poll = getPollCreation(pollMessage?.message || pollMessage);
    if (!poll) return null;
    const aggregates = aggregatePoll(pollMessage);
    const selectable = poll.selectableOptionsCount || poll.selectableCount;
    const lines = [`📊 Poll: ${poll.name || 'Untitled poll'}`];
    if (selectable && selectable > 1) {
        lines.push(`Select up to ${selectable} options.`);
    }
    aggregates.forEach((entry, idx) => {
        const voters = (entry.voters || [])
            .map((jid) => utils.whatsapp.jidToName(utils.whatsapp.formatJid(jid)))
            .filter(Boolean);
        const voteLabel = voters.length
            ? `${voters.length} vote${voters.length === 1 ? '' : 's'}: ${voters.join(', ')}`
            : '0 votes';
        lines.push(`${idx + 1}. ${entry.name || 'Unknown'} — ${voteLabel}`);
    });
    if (!aggregates.length && Array.isArray(poll.options)) {
        poll.options.forEach((opt, idx) => {
            lines.push(`${idx + 1}. ${opt.optionName || 'Option'}`);
        });
    }
    return lines.join('\n');
};

const isPinInChatMessage = (message = {}) => !!message?.pinInChatMessage;

const toBuffer = (val) => {
    if (!val) return null;
    if (Buffer.isBuffer(val)) return val;
    if (val instanceof Uint8Array) return Buffer.from(val);
    if (typeof val === 'string') {
        try {
            return Buffer.from(val, 'base64');
        } catch {
            return Buffer.from(val);
        }
    }
    return null;
};

const selectPnJid = (list = []) => (
    list.find((jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')) || null
);

const expandJidVariants = async (jid) => {
    const variants = new Set();
    const formatted = utils.whatsapp.formatJid(jid);
    if (formatted) variants.add(formatted);
    try {
        const [primary, alternate] = await utils.whatsapp.hydrateJidPair(formatted);
        [primary, alternate].map(utils.whatsapp.formatJid).forEach((entry) => {
            if (entry) variants.add(entry);
        });
    } catch (err) {
        state.logger?.debug?.({ err }, 'Failed to expand JID variants');
    }
    return Array.from(variants);
};

const getStoredMessageWithJidFallback = async (key = {}) => {
    const formattedRemote = utils.whatsapp.formatJid(key?.remoteJid);
    const formattedAlt = utils.whatsapp.formatJid(key?.participant || key?.participantAlt || key?.remoteJidAlt);
    const [primary, fallback] = await utils.whatsapp.hydrateJidPair(formattedRemote, formattedAlt);
    const candidates = new Set([formattedRemote, formattedAlt, primary, fallback].filter(Boolean));
    for (const remote of candidates) {
        const found = messageStore.get({ ...key, remoteJid: remote });
        if (found) {
            if (formattedRemote && remote && formattedRemote !== remote) {
                utils.whatsapp.migrateLegacyJid(formattedRemote, remote);
            }
            return found;
        }
    }
    return null;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isBroadcastJid = (jid = '') => typeof jid === 'string' && jid.endsWith('@broadcast');
const isNewsletterJid = (jid = '') => typeof jid === 'string' && jid.endsWith('@newsletter');
const normalizeSendJid = (jid) => utils.whatsapp.formatJid(jid) || jid;
const DISCORD_ATTACHMENT_MIME_BY_EXTENSION = {
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    aac: 'audio/aac',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    log: 'text/plain; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    zip: 'application/zip',
    '7z': 'application/x-7z-compressed',
    gz: 'application/gzip',
    tar: 'application/x-tar',
};
const guessAttachmentExtension = (value = '') => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const noFragment = trimmed.split('#')[0];
    const noQuery = noFragment.split('?')[0];
    const base = noQuery.split('/').filter(Boolean).pop() || noQuery;
    const match = base.match(/\.([a-z0-9]{1,16})$/i);
    return match ? match[1].toLowerCase() : null;
};
const inferAttachmentMimeType = (attachment = {}) => {
    const rawContentType = attachment?.contentType || attachment?.content_type;
    if (typeof rawContentType === 'string') {
        const normalized = rawContentType.split(';')[0].trim().toLowerCase();
        if (
            normalized.includes('/')
            && normalized !== 'application/octet-stream'
            && normalized !== 'binary/octet-stream'
        ) {
            return normalized;
        }
    }
    const extension = guessAttachmentExtension(attachment?.name) || guessAttachmentExtension(attachment?.url);
    if (extension && DISCORD_ATTACHMENT_MIME_BY_EXTENSION[extension]) {
        return DISCORD_ATTACHMENT_MIME_BY_EXTENSION[extension];
    }
    return 'application/octet-stream';
};
const normalizeAttachmentForWhatsAppSend = (attachment = {}) => {
    const normalized = { ...attachment };
    const normalizedName = typeof attachment?.name === 'string' && attachment.name.trim()
        ? attachment.name.trim()
        : '';
    const extensionFromName = guessAttachmentExtension(normalizedName);
    const extensionFromUrl = guessAttachmentExtension(attachment?.url);
    const mimetype = inferAttachmentMimeType(attachment);
    const extFromMime = mimetype.includes('/') ? mimetype.split('/')[1]?.split('+')?.[0] : null;
    const extension = extensionFromName || extensionFromUrl || extFromMime || 'bin';
    normalized.name = normalizedName || `attachment.${extension}`;
    normalized.contentType = mimetype;
    return normalized;
};
const buildSendOptionsForJid = (jid) => {
    const normalizedJid = normalizeSendJid(jid);
    return isBroadcastJid(normalizedJid) ? { broadcast: true } : {};
};
const getNewsletterServerIdFromMessage = (message) => {
    const candidates = [
        message?.key?.server_id,
        message?.key?.serverId,
        message?.messageServerID,
        message?.server_id,
        message?.serverId,
    ];
    for (const candidate of candidates) {
        const normalized = typeof candidate === 'string' ? candidate.trim() : String(candidate || '').trim();
        if (normalized) return normalized;
    }
    return null;
};
const mapDiscordMessageToWhatsAppMessage = ({ discordMessageId, sentMessage, isNewsletter = false }) => {
    const outboundIdRaw = sentMessage?.key?.id;
    const outboundId = typeof outboundIdRaw === 'string' ? outboundIdRaw.trim() : String(outboundIdRaw || '').trim();
    const serverId = isNewsletter ? getNewsletterServerIdFromMessage(sentMessage) : null;
    const preferredId = serverId || outboundId || null;
    if (!discordMessageId || !preferredId) return;

    state.lastMessages[discordMessageId] = preferredId;
    state.lastMessages[preferredId] = discordMessageId;

    if (outboundId) {
        state.lastMessages[outboundId] = discordMessageId;
        state.sentMessages.add(outboundId);
    }
    if (serverId && serverId !== outboundId) {
        state.sentMessages.add(serverId);
    }
};

const NEWSLETTER_ACK_ERROR_TTL_MS = 30 * 1000;
const NEWSLETTER_ACK_WAIT_MS = 900;
const newsletterAckErrors = new Map();
const newsletterAckWaiters = new Map();

const normalizeMessageId = (value) => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return String(value || '').trim();
};

const isLikelyNewsletterServerId = (value) => {
    const normalized = normalizeMessageId(value);
    if (!normalized) return false;
    if (/^\d+$/.test(normalized)) return true;
    if (/^(3EB|BAE5)/i.test(normalized)) return false;
    if (/^[A-F0-9]{16,}$/i.test(normalized)) return false;
    return true;
};

const pruneNewsletterAckErrors = () => {
    const cutoff = Date.now() - NEWSLETTER_ACK_ERROR_TTL_MS;
    for (const [messageId, payload] of newsletterAckErrors.entries()) {
        if (!payload || payload.timestamp < cutoff) {
            newsletterAckErrors.delete(messageId);
        }
    }
};

const resolveNewsletterAckWaiters = (messageId, errorCode) => {
    const waiters = newsletterAckWaiters.get(messageId);
    if (!waiters?.size) return;
    newsletterAckWaiters.delete(messageId);
    for (const resolve of waiters) {
        try {
            resolve(errorCode);
        } catch {
            continue;
        }
    }
};

const noteNewsletterAckError = ({ messageId, jid, errorCode }) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) return;
    const normalizedError = normalizeMessageId(errorCode) || 'unknown';
    pruneNewsletterAckErrors();
    newsletterAckErrors.set(normalizedMessageId, {
        errorCode: normalizedError,
        jid: normalizeSendJid(jid),
        timestamp: Date.now(),
    });
    resolveNewsletterAckWaiters(normalizedMessageId, normalizedError);
};

const waitForNewsletterAckError = async (messageId, timeoutMs = NEWSLETTER_ACK_WAIT_MS) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) return null;
    pruneNewsletterAckErrors();
    const cached = newsletterAckErrors.get(normalizedMessageId);
    if (cached?.errorCode) {
        return cached.errorCode;
    }
    return await new Promise((resolve) => {
        const existing = newsletterAckWaiters.get(normalizedMessageId) || new Set();
        const settle = (errorCode = null) => {
            clearTimeout(timer);
            existing.delete(settle);
            if (existing.size) {
                newsletterAckWaiters.set(normalizedMessageId, existing);
            } else {
                newsletterAckWaiters.delete(normalizedMessageId);
            }
            resolve(errorCode || null);
        };
        existing.add(settle);
        newsletterAckWaiters.set(normalizedMessageId, existing);
        const timer = setTimeout(() => settle(null), timeoutMs);
        if (typeof timer?.unref === 'function') {
            timer.unref();
        }
    });
};

const clearFailedNewsletterMapping = ({ discordMessageId, sentMessage }) => {
    const normalizedDiscordMessageId = normalizeMessageId(discordMessageId);
    if (!normalizedDiscordMessageId) return;
    const outboundId = normalizeMessageId(sentMessage?.key?.id);
    const serverId = normalizeMessageId(getNewsletterServerIdFromMessage(sentMessage));
    const removeIfMatches = (key) => {
        if (!key) return;
        if (state.lastMessages[key] === normalizedDiscordMessageId) {
            delete state.lastMessages[key];
        }
    };
    if (
        state.lastMessages[normalizedDiscordMessageId] === outboundId
        || (serverId && state.lastMessages[normalizedDiscordMessageId] === serverId)
    ) {
        delete state.lastMessages[normalizedDiscordMessageId];
    }
    removeIfMatches(outboundId);
    removeIfMatches(serverId);
    if (outboundId) state.sentMessages.delete(outboundId);
    if (serverId) state.sentMessages.delete(serverId);
};

const mapNewsletterServerIdFromOutbound = ({ outboundId, serverId }) => {
    const normalizedOutboundId = normalizeMessageId(outboundId);
    const normalizedServerId = normalizeMessageId(serverId);
    if (!normalizedOutboundId || !normalizedServerId || normalizedOutboundId === normalizedServerId) {
        return null;
    }
    const discordMessageId = normalizeMessageId(state.lastMessages[normalizedOutboundId]);
    if (!discordMessageId) {
        return null;
    }
    state.lastMessages[discordMessageId] = normalizedServerId;
    state.lastMessages[normalizedServerId] = discordMessageId;
    state.sentMessages.add(normalizedServerId);
    return normalizedServerId;
};

const resolveNewsletterServerIdForDiscordMessage = ({ discordMessageId, candidateId = null }) => {
    const normalizedCandidateId = normalizeMessageId(candidateId);
    if (isLikelyNewsletterServerId(normalizedCandidateId)) {
        return normalizedCandidateId;
    }
    const normalizedDiscordMessageId = normalizeMessageId(discordMessageId)
        || normalizeMessageId(state.lastMessages[normalizedCandidateId]);
    if (!normalizedDiscordMessageId) {
        return normalizedCandidateId || null;
    }
    for (const [waId, dcId] of Object.entries(state.lastMessages)) {
        if (normalizeMessageId(dcId) !== normalizedDiscordMessageId) continue;
        if (isLikelyNewsletterServerId(waId)) {
            return normalizeMessageId(waId);
        }
    }
    return normalizedCandidateId || null;
};

const toMentionLabel = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/^@+/, '');
    if (!trimmed) return null;
    return `@${trimmed}`;
};

const replaceLiteralMentionTokens = (text, replacements = []) => {
    if (!text || !Array.isArray(replacements) || !replacements.length) return text;
    let nextText = text;
    for (const replacement of replacements) {
        const value = typeof replacement?.value === 'string' ? replacement.value.trim() : '';
        if (!value) continue;
        const rawTokens = Array.isArray(replacement?.rawTokens) ? replacement.rawTokens : [];
        const candidates = [...new Set(rawTokens
            .map((token) => (typeof token === 'string' ? token.trim() : ''))
            .filter(Boolean))];
        for (const token of candidates) {
            const regex = new RegExp(escapeRegex(token), 'g');
            nextText = nextText.replace(regex, value);
        }
    }
    return nextText;
};

const DISCORD_USER_MENTION_REGEX = /<@!?(\d+)>/g;
const DISCORD_ROLE_MENTION_REGEX = /<@&(\d+)>/g;
const DISCORD_REPLY_PREFIX_REGEX = /^(<@!?\d+>|@\S+)\s*/;

const extractMentionIdsFromText = (text, regex) => {
    const ids = new Set();
    if (typeof text !== 'string' || !text) return ids;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const id = String(match[1] || '').trim();
        if (/^\d+$/.test(id)) ids.add(id);
    }
    return ids;
};

const collectDiscordMentionData = async (message, textCandidates = [], replyMentionId = null) => {
    const mentionDescriptors = [];
    const fallbackReplacements = [];
    const seenUsers = new Set();
    const seenRoles = new Set();

    const addUserMention = (user, member = null) => {
        if (!user?.id) return;
        if (replyMentionId && user.id === replyMentionId) return;
        if (seenUsers.has(user.id)) return;
        seenUsers.add(user.id);
        const displayTokens = [...new Set([
            member?.displayName,
            user.globalName,
            user.username,
        ].map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))];
        const rawTokens = [`<@${user.id}>`, `<@!${user.id}>`];
        mentionDescriptors.push({
            discordUserId: user.id,
            displayTokens,
            rawTokens,
        });
        const fallbackLabel = toMentionLabel(displayTokens[0]);
        if (fallbackLabel) {
            fallbackReplacements.push({ rawTokens, value: fallbackLabel });
        }
    };

    const addRoleMention = (role) => {
        if (!role?.id) return;
        if (seenRoles.has(role.id)) return;
        seenRoles.add(role.id);
        const fallbackLabel = toMentionLabel(role.name);
        if (!fallbackLabel) return;
        fallbackReplacements.push({
            rawTokens: [`<@&${role.id}>`],
            value: fallbackLabel,
        });
    };

    const mentionedUsers = message?.mentions?.users ? [...message.mentions.users.values()] : [];
    for (const user of mentionedUsers) {
        const member = message?.mentions?.members?.get(user.id);
        addUserMention(user, member);
    }

    const mentionedRoles = message?.mentions?.roles ? [...message.mentions.roles.values()] : [];
    for (const role of mentionedRoles) {
        addRoleMention(role);
    }

    const userIdsFromText = new Set();
    const roleIdsFromText = new Set();
    for (const candidate of textCandidates) {
        extractMentionIdsFromText(candidate, DISCORD_USER_MENTION_REGEX).forEach((id) => userIdsFromText.add(id));
        extractMentionIdsFromText(candidate, DISCORD_ROLE_MENTION_REGEX).forEach((id) => roleIdsFromText.add(id));
    }

    for (const userId of userIdsFromText) {
        if (replyMentionId && userId === replyMentionId) continue;
        if (seenUsers.has(userId)) continue;
        const user = message?.mentions?.users?.get(userId)
            || await message?.client?.users?.fetch?.(userId).catch(() => null);
        const member = message?.mentions?.members?.get(userId)
            || message?.guild?.members?.cache?.get?.(userId)
            || await message?.guild?.members?.fetch?.(userId).catch(() => null);
        if (user) addUserMention(user, member);
    }

    for (const roleId of roleIdsFromText) {
        if (seenRoles.has(roleId)) continue;
        const role = message?.mentions?.roles?.get(roleId)
            || message?.guild?.roles?.cache?.get?.(roleId)
            || await message?.guild?.roles?.fetch?.(roleId).catch(() => null);
        if (role) addRoleMention(role);
    }

    return { mentionDescriptors, fallbackReplacements };
};

const normalizeMentionJidsForChat = async (jid, mentionJids = []) => [...new Set((await Promise.all(
    [...new Set((Array.isArray(mentionJids) ? mentionJids : []).filter(Boolean))]
        .map((candidate) => utils.whatsapp.preferMentionJidForChat(candidate, jid)),
)).filter(Boolean))];

const resolveDiscordTextMentionsForWhatsApp = async ({
    message,
    text,
    jid,
    textCandidates = [],
    replyMentionId = null,
}) => {
    const { mentionDescriptors, fallbackReplacements } = await collectDiscordMentionData(
        message,
        textCandidates,
        replyMentionId,
    );
    const linkedMentions = typeof utils.whatsapp.applyDiscordMentionLinks === 'function'
        ? await utils.whatsapp.applyDiscordMentionLinks(text, mentionDescriptors, { chatJid: jid })
        : { text, mentionJids: [] };
    const updatedText = replaceLiteralMentionTokens(linkedMentions.text ?? text, fallbackReplacements);
    const mentionJidsRaw = [...new Set([
        ...(Array.isArray(linkedMentions.mentionJids) ? linkedMentions.mentionJids : []),
        ...utils.whatsapp.getMentionedJids(updatedText),
    ])];
    const mentionJids = await normalizeMentionJidsForChat(jid, mentionJidsRaw);
    return { text: updatedText, mentionJids };
};

const handlePollUpdateMessage = async (client, rawMessage) => {
    const pollUpdate = rawMessage?.message?.pollUpdateMessage;
    const pollKey = pollUpdate?.pollCreationMessageKey;
    if (!pollUpdate || !pollKey) return false;

    const normalizedKey = {
        ...pollKey,
        remoteJid: utils.whatsapp.formatJid(pollKey.remoteJid || rawMessage.key?.remoteJid),
        participant: utils.whatsapp.formatJid(pollKey.participant || pollKey.participantAlt),
    };
    const pollMessage = await getStoredMessageWithJidFallback(normalizedKey);
    if (!pollMessage) {
        state.logger?.warn({ key: normalizedKey }, 'Received poll vote without cached poll message');
        return false;
    }

    const pollEncKey = toBuffer(getPollEncKey(pollMessage.message || pollMessage));
    if (!pollEncKey) {
        state.logger?.warn({ key: normalizedKey }, 'Missing poll enc key for incoming poll update');
        return false;
    }

    const meIdRaw = utils.whatsapp.formatJid(client?.user?.id);
    const [mePrimary, meFallback] = await utils.whatsapp.hydrateJidPair(meIdRaw);
    const meId = utils.whatsapp.formatJid(mePrimary || meFallback || meIdRaw);
    const creationKeyForAuth = {
        ...pollUpdate.pollCreationMessageKey,
        remoteJid: utils.whatsapp.formatJid(pollUpdate.pollCreationMessageKey?.remoteJid || pollMessage.key?.remoteJid),
        participant: utils.whatsapp.formatJid(pollUpdate.pollCreationMessageKey?.participant),
    };
    const pollCreatorJid = pollUpdate.pollCreationMessageKey?.fromMe
        ? meId
        : getKeyAuthor(creationKeyForAuth, meId);
    const voterPn = selectPnJid([
        rawMessage.key?.participant,
        rawMessage.key?.remoteJid,
        pollUpdate.pollCreationMessageKey?.remoteJid,
        pollMessage.key?.remoteJid,
        pollMessage.key?.remoteJidAlt,
    ].map(utils.whatsapp.formatJid));
    const voterJid = voterPn || getKeyAuthor(rawMessage.key, meId);

    const encPayload = toBuffer(pollUpdate.vote?.encPayload);
    const encIv = toBuffer(pollUpdate.vote?.encIv);
    if (!encPayload || !encIv) {
        state.logger?.warn({ key: normalizedKey }, 'Missing poll vote payload bytes');
        return false;
    }

    const baseCreatorCandidates = [
        pollCreatorJid,
        utils.whatsapp.formatJid(pollUpdate.pollCreationMessageKey?.participant),
        utils.whatsapp.formatJid(pollUpdate.pollCreationMessageKey?.remoteJidAlt),
        utils.whatsapp.formatJid(pollMessage.key?.remoteJidAlt),
        utils.whatsapp.formatJid(pollMessage.key?.remoteJid),
    ].filter(Boolean);
    const baseVoterCandidates = [
        voterJid,
        selectPnJid([
            rawMessage.key?.remoteJidAlt,
            pollUpdate.pollCreationMessageKey?.remoteJidAlt,
            pollMessage.key?.remoteJidAlt,
        ].map(utils.whatsapp.formatJid)),
        utils.whatsapp.formatJid(rawMessage.key?.remoteJidAlt),
        utils.whatsapp.formatJid(rawMessage.key?.participant),
    ].filter(Boolean);

    const creatorCandidates = (await Promise.all(baseCreatorCandidates.map(expandJidVariants)))
        .flat()
        .filter(Boolean);
    const voterCandidates = (await Promise.all(baseVoterCandidates.map(expandJidVariants)))
        .flat()
        .filter(Boolean);

    let voteMsg = null;
    let usedCreator = null;
    let usedVoter = null;
    const pollMsgId = pollUpdate.pollCreationMessageKey?.id || (pollMessage.key || normalizedKey).id;

    for (const creator of creatorCandidates) {
        for (const voter of voterCandidates) {
            try {
                voteMsg = decryptPollVote(
                    { encPayload, encIv },
                    {
                        pollEncKey,
                        pollCreatorJid: creator,
                        pollMsgId,
                        voterJid: voter,
                    }
                );
                usedCreator = creator;
                usedVoter = voter;
                break;
            } catch (err) {
                continue;
            }
        }
        if (voteMsg) break;
    }

    state.logger?.info({
        key: normalizedKey,
        pollCreationKey: pollUpdate.pollCreationMessageKey,
        pollMessageKey: pollMessage?.key,
        pollCreatorCandidates: creatorCandidates,
        pollVoterCandidates: voterCandidates,
        pollCreatorJid,
        voterJid,
        usedCreator,
        usedVoter,
        encKeyLen: pollEncKey?.length,
        encPayloadLen: encPayload?.length,
        encIvLen: encIv?.length,
        success: !!voteMsg,
    }, 'Poll vote debug');

    if (!voteMsg) {
        state.logger?.warn({ pollMsgId }, 'Failed to decrypt poll vote');
        return false;
    }

    const update = {
        pollUpdateMessageKey: rawMessage.key,
        vote: voteMsg,
        senderTimestampMs: Number(pollUpdate.senderTimestampMs) || Date.now(),
    };

    client.ev.emit('messages.update', [
        { key: normalizedKey, update: { pollUpdates: [update] } },
    ]);
    state.logger?.info({
        pollCreationKey: normalizedKey,
        pollCreatorJid: usedCreator,
        voterJid: usedVoter,
        senderTimestampMs: update.senderTimestampMs,
    }, 'Poll vote decrypted');
    return true;
};

const storeMessage = (message) => {
    if (!message?.key) return;
    const normalizedKey = {
        ...message.key,
        remoteJid: utils.whatsapp.formatJid(message.key.remoteJid),
        participant: utils.whatsapp.formatJid(message.key.participant || message.key.participantAlt),
    };
    messageStore.set({ ...message, key: normalizedKey });
};

const cacheGroupMetadata = (metadata, client) => {
    const normalizedJid = utils.whatsapp.formatJid(metadata?.id);
    if (!normalizedJid) {
        return;
    }
    groupMetadataCache.set(normalizedJid, metadata);
    if (metadata.subject) {
        state.contacts[normalizedJid] = metadata.subject;
        client.contacts[normalizedJid] = metadata.subject;
    }
};

const groupRefreshLastRun = new Map();
const refreshGroupMetadata = async (client, groupId) => {
    const normalizedId = utils.whatsapp.formatJid(groupId);
    if (!normalizedId) {
        return null;
    }
    const now = Date.now();
    const last = groupRefreshLastRun.get(normalizedId) || 0;
    const minGapMs = 30 * 1000;
    if (now - last < minGapMs) {
        return null;
    }
    groupRefreshLastRun.set(normalizedId, now);
    try {
        groupMetadataCache.invalidate(normalizedId);
        const metadata = await client.groupMetadata(normalizedId);
        cacheGroupMetadata(metadata, client);
        return metadata;
    } catch (err) {
        const isRateLimit = err?.message?.includes('rate-overlimit') || err?.data === 429;
        const level = isRateLimit ? 'debug' : 'warn';
        state.logger?.[level]?.({ err, groupId: normalizedId }, 'Failed to refresh group metadata');
        if (isRateLimit) {

            groupRefreshLastRun.set(normalizedId, now + minGapMs);
        }
        return null;
    }
};

const patchGroupMetadataForCache = (client) => {
    if (!client || client.__wa2dcGroupCachePatched || typeof client.groupMetadata !== 'function') {
        return;
    }
    const baseGroupMetadata = client.groupMetadata.bind(client);
    client.groupMetadata = async (...args) => {
        const metadata = await baseGroupMetadata(...args);
        cacheGroupMetadata(metadata, client);
        return metadata;
    };
    client.__wa2dcGroupCachePatched = true;
};

const patchSendMessageForLinkPreviews = (client) => {
    if (!client || client.__wa2dcLinkPreviewPatched || typeof client.sendMessage !== 'function') {
        return;
    }
    const defaultGetUrlInfo = (text) => utils.whatsapp.generateLinkPreview(text, {
        uploadImage: typeof client.waUploadToServer === 'function' ? client.waUploadToServer : undefined,
        logger: state.logger,
    });
    const baseSendMessage = client.sendMessage.bind(client);
    client.sendMessage = async (jid, content, options) => {
        let sendJid = jid;
        try {
            if (typeof utils.whatsapp.hydrateJidPair === 'function') {
                const [resolvedJid] = await utils.whatsapp.hydrateJidPair(jid);
                sendJid = resolvedJid || jid;
            } else if (typeof utils.whatsapp.formatJid === 'function') {
                sendJid = utils.whatsapp.formatJid(jid) || jid;
            }
        } catch (err) {
            state.logger?.debug?.({ err, jid }, 'Failed to resolve preferred WhatsApp JID for sendMessage');
        }
        const normalizedOptions = options ? { ...options } : {};
        if (!normalizedOptions.logger) {
            normalizedOptions.logger = state.logger;
        }
        const needsGeneratedPreview = !content?.linkPreview;
        if (needsGeneratedPreview && !normalizedOptions.getUrlInfo) {
            normalizedOptions.getUrlInfo = defaultGetUrlInfo;
        }
        return baseSendMessage(sendJid, content, normalizedOptions);
    };
    client.__wa2dcLinkPreviewPatched = true;
};

const ensureSignalStoreSupport = async (keyStore) => {
    if (!keyStore?.get || !keyStore?.set) {
        return;
    }

    const requiredKeys = ['tctoken', 'lid-mapping', 'device-list', 'device-index'];
    for (const key of requiredKeys) {
        try {
            const existing = await keyStore.get(key, []);
            if (existing == null) {
                await keyStore.set({ [key]: {} });
            }
        } catch (err) {
            state.logger?.warn({ err, key }, 'Failed to ensure auth store compatibility');
        }
    }
};

const migrateLegacyChats = async (client) => {
    const store = client.signalRepository?.lidMapping;
    if (!store) return;
    const lidJids = Object.keys(state.chats).filter((jid) => jid.endsWith('@lid'));
    if (!lidJids.length) return;
    try {
        const mappings = typeof store.getPNsForLIDs === 'function'
            ? await store.getPNsForLIDs(lidJids)
            : {};
        for (const lidJid of lidJids) {
            let pnJid = mappings?.[lidJid];
            if (!pnJid && typeof store.getPNForLID === 'function') {

                pnJid = await store.getPNForLID(lidJid);
            }
            const formattedPn = utils.whatsapp.formatJid(pnJid);
            if (formattedPn && utils.whatsapp.isPhoneJid(formattedPn)) {
                utils.whatsapp.migrateLegacyJid(lidJid, formattedPn);
            }
        }
    } catch (err) {
        state.logger?.warn({ err }, 'Failed to migrate LID chats to PNs');
    }
};

const connectToWhatsApp = async (retry = 1) => {
    const controlChannel = await utils.discord.getControlChannel().catch(() => null);
    const { version } = await getBaileysVersion();
    const sendControlMessage = async (message) => {
        if (!controlChannel || state.shutdownRequested) {
            return;
        }
        try {
            await controlChannel.send(message);
        } catch (err) {
            state.logger?.debug?.({ err }, 'Failed to send WhatsApp status to control channel');
        }
    };

    if (!groupCachePruneInterval) {
        groupCachePruneInterval = setInterval(() => groupMetadataCache.prune(), 60 * 60 * 1000);
        if (typeof groupCachePruneInterval?.unref === 'function') {
            groupCachePruneInterval.unref();
        }
    }

    const client = createWhatsAppClient({
        version,
        printQRInTerminal: false,
        auth: authState,
        logger: state.logger,
        markOnlineOnConnect: false,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        generateHighQualityLinkPreview: true,
        cachedGroupMetadata: async (jid) => groupMetadataCache.get(utils.whatsapp.formatJid(jid)),
        getMessage: async (key) => {
            const stored = await getStoredMessageWithJidFallback({ ...key, remoteJid: utils.whatsapp.formatJid(key?.remoteJid) });
            if (!stored) return null;

            return stored.message || stored;
        },
        browser: ["Firefox (Linux)", "", ""]
    });
    client.contacts = state.contacts;
    patchSendMessageForLinkPreviews(client);
    patchGroupMetadataForCache(client);
    const groupRefreshScheduler = createGroupRefreshScheduler({
        refreshFn: (jid) => refreshGroupMetadata(client, jid),
    });

    client.ev.on('connection.update', async (update) => {
        try {
            if (state.shutdownRequested) {
                return;
            }

            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                utils.whatsapp.sendQR(qr);
            }
            if (connection === 'close') {
                state.logger.error(lastDisconnect?.error);
                groupRefreshScheduler.clearAll();
                groupMetadataCache.clear();
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
                    await sendControlMessage('WhatsApp session invalid. Please rescan the QR code.');
                    await utils.whatsapp.deleteSession();
                    await actions.start(true);
                    return;
                }
                const delayMs = getReconnectDelayMs(retry);
                const humanReason = formatDisconnectReason(statusCode);
                if (delayMs === 0) {
                    await sendControlMessage(`WhatsApp connection failed (${humanReason}). Trying to reconnect! Retry #${retry}`);
                } else {
                    const delaySeconds = Math.round(delayMs / 1000);
                    await sendControlMessage(`WhatsApp connection failed (${humanReason}). Waiting ${delaySeconds} seconds before trying to reconnect! Retry #${retry}.`);
                    await sleep(delayMs);
                }
                if (!state.shutdownRequested) {
                    await connectToWhatsApp(retry + 1);
                }
                return;
            } else if (connection === 'open') {
                state.waClient = client;

                retry = 1;
                await sendControlMessage('WhatsApp connection successfully opened!');

                try {
                    const groups = await client.groupFetchAllParticipating();
                    groupMetadataCache.prime(groups);
                    for (const [jid, data] of Object.entries(groups)) {
                        state.contacts[jid] = data.subject;
                        client.contacts[jid] = data.subject;
                    }
                    await migrateLegacyChats(client);
                } catch (err) {
                    state.logger?.error(err);
                }
            }
        } catch (err) {
            state.logger?.warn({ err }, 'Failed to handle WhatsApp connection.update');
        }
    });
    const credsListener = typeof saveState === 'function' ? saveState : () => {};
    client.ev.on('creds.update', credsListener);
    const contactUpdater = utils.whatsapp.updateContacts.bind(utils.whatsapp);
    ['chats.set', 'contacts.set', 'chats.upsert', 'chats.update', 'contacts.upsert', 'contacts.update', 'groups.upsert', 'groups.update']
      .forEach((eventName) => client.ev.on(eventName, contactUpdater));

    client.ev.on('groups.upsert', async (groups) => {
        const list = Array.isArray(groups) ? groups : [groups];
        for (const group of list) {
            cacheGroupMetadata(group, client);
            groupRefreshScheduler.schedule(group.id);
        }
    });

    client.ev.on('groups.update', async (updates = []) => {
        const list = Array.isArray(updates) ? updates : [updates];
        for (const update of list) {
            if (!update?.id) continue;
            if (update.subject) {
                cacheGroupMetadata({ id: update.id, subject: update.subject }, client);
            }
            groupRefreshScheduler.schedule(update.id);
        }
    });

    client.ev.on('group-participants.update', async (event) => {
        if (!event?.id) return;
        groupRefreshScheduler.schedule(event.id);
    });

    client.ev.on('lid-mapping.update', ({ lid, pn }) => {
        const normalizedLid = utils.whatsapp.formatJid(lid);
        const normalizedPn = utils.whatsapp.formatJid(pn);
        if (!normalizedLid || !normalizedPn) return;
        const lidJid = utils.whatsapp.isLidJid(normalizedLid)
            ? normalizedLid
            : (utils.whatsapp.isLidJid(normalizedPn) ? normalizedPn : null);
        const pnJid = utils.whatsapp.isPhoneJid(normalizedLid)
            ? normalizedLid
            : (utils.whatsapp.isPhoneJid(normalizedPn) ? normalizedPn : null);
        if (lidJid && pnJid) {
            utils.whatsapp.migrateLegacyJid(lidJid, pnJid);
        }
    });

    client.ev.on('messages.upsert', async (update) => {
        if (['notify', 'append'].includes(update.type)) {
            for await (const rawMessage of update.messages) {
                const messageId = normalizeMessageId(utils.whatsapp.getId(rawMessage));
                const outboundId = normalizeMessageId(rawMessage?.key?.id);
                const serverId = normalizeMessageId(getNewsletterServerIdFromMessage(rawMessage));
                const remoteJid = normalizeSendJid(rawMessage?.key?.remoteJid || rawMessage?.chatId || rawMessage?.attrs?.from);
                const newsletterChat = isNewsletterJid(remoteJid);
                const sentCandidates = [...new Set([messageId, outboundId, serverId].filter(Boolean))];
                if (sentCandidates.some((id) => state.sentMessages.has(id))) {
                    if (newsletterChat) {
                        mapNewsletterServerIdFromOutbound({ outboundId, serverId });
                    }
                    sentCandidates.forEach((id) => state.sentMessages.delete(id));
                    continue;
                }
                if (newsletterChat && rawMessage?.key?.fromMe && outboundId && state.lastMessages[outboundId]) {
                    mapNewsletterServerIdFromOutbound({ outboundId, serverId });
                    continue;
                }
                const messageType = utils.whatsapp.getMessageType(rawMessage);
                storeMessage(rawMessage);
                if (!utils.whatsapp.inWhitelist(rawMessage) || !utils.whatsapp.sentAfterStart(rawMessage) || !messageType) continue;

                if (utils.whatsapp.isStatusBroadcast(rawMessage) && !state.settings.MirrorWAStatuses) {
                    continue;
                }

                if (messageType === 'pollUpdateMessage') {
                    const handled = await handlePollUpdateMessage(client, rawMessage);
                    if (handled) continue;
                }

                const channelJid = await utils.whatsapp.getChannelJid(rawMessage);
                if (!channelJid) {
                    continue;
                }

                if (isPinInChatMessage(rawMessage.message)) {
                    const { pinInChatMessage } = rawMessage.message;
                    const targetKey = {
                        ...pinInChatMessage.key,
                        remoteJid: utils.whatsapp.formatJid(pinInChatMessage.key?.remoteJid || channelJid),
                    };
                    const isPin = pinInChatMessage.type === proto.Message.PinInChatMessage.Type.PIN_FOR_ALL
                        || pinInChatMessage.type === 1;
                    const pinNoticeKey = rawMessage?.key?.id
                        ? {
                            ...rawMessage.key,
                            remoteJid: utils.whatsapp.formatJid(rawMessage.key.remoteJid || channelJid),
                            participant: utils.whatsapp.formatJid(rawMessage.key.participant || rawMessage.key.participantAlt),
                        }
                        : null;
                    const isSelfPin = state.sentPins.has(targetKey.id) || (pinNoticeKey?.id && state.sentPins.has(pinNoticeKey.id));
                    if (isSelfPin) {
                        state.sentPins.delete(targetKey.id);
                        if (pinNoticeKey?.id) state.sentPins.delete(pinNoticeKey.id);
                        if (pinNoticeKey?.id) {
                            try {
                                await client.sendMessage(pinNoticeKey.remoteJid, { delete: pinNoticeKey });
                            } catch (err) {
                                state.logger?.debug?.({ err }, 'Failed to delete local pin notice');
                            }
                        }
                    } else {
                        state.dcClient.emit('whatsappPin', {
                            jid: channelJid,
                            key: targetKey,
                            pinned: isPin,
                            actor: await utils.whatsapp.getSenderName(rawMessage),
                        });
                    }
                    continue;
                }

                const pollCreation = getPollCreation(rawMessage.message);
                if (pollCreation) {
                    const pollText = formatPollForDiscord(rawMessage);
                    const name = await utils.whatsapp.getSenderName(rawMessage);
                    const pollOptions = getPollOptions(pollCreation);
                    state.dcClient.emit('whatsappMessage', {
                        id: utils.whatsapp.getId(rawMessage),
                        name,
                        content: pollText || pollCreation.name || 'Poll',
                        quote: await utils.whatsapp.getQuote(rawMessage),
                        file: null,
                        profilePic: await utils.whatsapp.getProfilePic(rawMessage),
                        channelJid,
                        isGroup: utils.whatsapp.isGroup(rawMessage),
                        isForwarded: utils.whatsapp.isForwarded(rawMessage.message, rawMessage?.message?.messageContextInfo),
                        isEdit: false,
                        isPoll: true,
                        pollOptions,
                        pollSelectableCount: pollCreation.selectableOptionsCount || pollCreation.selectableCount || 1,
                    });
                    const ts = utils.whatsapp.getTimestamp(rawMessage);
                    if (ts > state.startTime) state.startTime = ts;
                    continue;
                }

                const [nMsgType, message] = utils.whatsapp.getMessage(rawMessage, messageType);
                const { content, discordMentions } = await utils.whatsapp.getContent(message, nMsgType, messageType, { mentionTarget: 'discord' });
                state.dcClient.emit('whatsappMessage', {
                    id: utils.whatsapp.getId(rawMessage),
                    name: await utils.whatsapp.getSenderName(rawMessage),
                    content,
                    quote: await utils.whatsapp.getQuote(rawMessage),
                    file: await utils.whatsapp.getFile(rawMessage, messageType),
                    profilePic: await utils.whatsapp.getProfilePic(rawMessage),
                    channelJid: await utils.whatsapp.getChannelJid(rawMessage),
                    isGroup: utils.whatsapp.isGroup(rawMessage),
                    isForwarded: utils.whatsapp.isForwarded(message, rawMessage?.message?.messageContextInfo),
                    isEdit: messageType === 'editedMessage',
                    discordMentions,
                });
                const ts = utils.whatsapp.getTimestamp(rawMessage);
                if (ts > state.startTime) state.startTime = ts;
            }
        }
    });

    client.ev.on('messages.reaction', async (reactions) => {
        for await (const rawReaction of reactions) {
            if (!utils.whatsapp.inWhitelist(rawReaction) || !utils.whatsapp.sentAfterStart(rawReaction))
                continue;

            const msgId = utils.whatsapp.getId(rawReaction);
            if (state.sentReactions.has(msgId)) {
                state.sentReactions.delete(msgId);
                continue;
            }

            state.dcClient.emit('whatsappReaction', {
                id: msgId,
                jid: await utils.whatsapp.getChannelJid(rawReaction),
                text: rawReaction.reaction.text,
                author: await utils.whatsapp.getSenderJid(rawReaction, rawReaction.key.fromMe),
            });
            const ts = utils.whatsapp.getTimestamp(rawReaction);
            if (ts > state.startTime) state.startTime = ts;
        }
    });

    client.ev.on('newsletter.reaction', async (update = {}) => {
        const jid = utils.whatsapp.formatJid(update?.id);
        if (!jid) {
            return;
        }
        if (!utils.whatsapp.inWhitelist({ key: { remoteJid: jid } })) {
            return;
        }

        const serverId = typeof update?.server_id === 'string'
            ? update.server_id.trim()
            : String(update?.server_id || '').trim();
        if (!serverId) {
            return;
        }
        if (state.sentReactions.has(serverId)) {
            state.sentReactions.delete(serverId);
            return;
        }

        const reactionCode = typeof update?.reaction?.code === 'string' ? update.reaction.code.trim() : '';
        const removed = Boolean(update?.reaction?.removed) || !reactionCode;
        const syntheticAuthor = reactionCode
            ? `newsletter:${serverId}:${reactionCode}`
            : `newsletter:${serverId}`;

        state.dcClient.emit('whatsappReaction', {
            id: serverId,
            jid,
            text: removed ? '' : reactionCode,
            author: syntheticAuthor,
        });
    });

    client.ev.on('messages.delete', async (updates) => {
        const keys = 'keys' in updates ? updates.keys : updates;
        for (const key of keys) {
            if (!utils.whatsapp.inWhitelist({ key })) continue;
            const jid = await utils.whatsapp.getChannelJid({ key });
            if (!jid) continue;
            const id = getNewsletterServerIdFromMessage({ key }) || key?.id;
            if (!id) continue;
            state.dcClient.emit('whatsappDelete', {
                id,
                jid,
            });
        }
    });

    client.ev.on('messages.update', async (updates) => {
        for (const { update, key } of updates) {
            const normalizedRemoteJid = normalizeSendJid(key?.remoteJid);
            if (
                key?.fromMe
                && update?.status === WAMessageStatus.ERROR
                && isNewsletterJid(normalizedRemoteJid)
            ) {
                const [errorCodeRaw] = Array.isArray(update?.messageStubParameters)
                    ? update.messageStubParameters
                    : [];
                const errorCode = normalizeMessageId(errorCodeRaw) || 'unknown';
                noteNewsletterAckError({
                    messageId: key?.id,
                    jid: normalizedRemoteJid,
                    errorCode,
                });
                state.logger?.warn?.({
                    jid: normalizedRemoteJid,
                    id: key?.id,
                    error: errorCode,
                }, 'Newsletter send failed with ack error');
            }
            if (Array.isArray(update.pollUpdates) && update.pollUpdates.length) {
                    const pollMessage = messageStore.get({ ...key, remoteJid: utils.whatsapp.formatJid(key?.remoteJid) });
                    if (!pollMessage) {
                        state.logger?.warn({ key }, 'Received poll update without stored poll creation message');
                        continue;
                    }
                for (const pollUpdate of update.pollUpdates) {
                    updateMessageWithPollUpdate(pollMessage, pollUpdate);
                }
                storeMessage(pollMessage);
                const pollText = formatPollForDiscord(pollMessage);
                const channelJid = await utils.whatsapp.getChannelJid({ key });
                if (pollText && channelJid) {
                    state.dcClient.emit('whatsappMessage', {
                        id: key.id,
                        name: await utils.whatsapp.getSenderName(pollMessage),
                        content: pollText,
                        channelJid,
                        profilePic: await utils.whatsapp.getProfilePic(pollMessage),
                        isGroup: utils.whatsapp.isGroup({ key }),
                        isForwarded: false,
                        isEdit: true,
                        isPoll: true,
                        pollOptions: getPollOptions(getPollCreation(pollMessage.message)),
                        pollSelectableCount: pollMessage?.message?.pollCreationMessage?.selectableOptionsCount
                            || pollMessage?.message?.pollCreationMessage?.selectableCount
                            || pollMessage?.message?.pollCreationMessageV2?.selectableOptionsCount
                            || pollMessage?.message?.pollCreationMessageV2?.selectableCount
                            || pollMessage?.message?.pollCreationMessageV3?.selectableOptionsCount
                            || pollMessage?.message?.pollCreationMessageV3?.selectableCount
                            || pollMessage?.message?.pollCreationMessageV4?.selectableOptionsCount
                            || pollMessage?.message?.pollCreationMessageV4?.selectableCount
                            || 1,
                    });
                }
                continue;
            }
            if (isPinInChatMessage(update.message)) {
                const { pinInChatMessage } = update.message;
                const targetKey = {
                    ...pinInChatMessage.key,
                    remoteJid: utils.whatsapp.formatJid(pinInChatMessage.key?.remoteJid || key?.remoteJid),
                };
                const isPin = pinInChatMessage.type === proto.Message.PinInChatMessage.Type.PIN_FOR_ALL
                    || pinInChatMessage.type === 1;
                const pinNoticeKey = key?.id
                    ? {
                        ...key,
                        remoteJid: utils.whatsapp.formatJid(key.remoteJid || targetKey.remoteJid),
                        participant: utils.whatsapp.formatJid(key.participant || key.participantAlt),
                    }
                    : null;
                const isSelfPin = state.sentPins.has(targetKey.id) || (pinNoticeKey?.id && state.sentPins.has(pinNoticeKey.id));
                if (isSelfPin) {
                    state.sentPins.delete(targetKey.id);
                    if (pinNoticeKey?.id) state.sentPins.delete(pinNoticeKey.id);
                    if (pinNoticeKey?.id) {
                        try {
                            await client.sendMessage(pinNoticeKey.remoteJid, { delete: pinNoticeKey });
                        } catch (err) {
                            state.logger?.debug?.({ err }, 'Failed to delete local pin notice');
                        }
                    }
                } else {
                    state.dcClient.emit('whatsappPin', {
                        jid: await utils.whatsapp.getChannelJid({ key }),
                        key: targetKey,
                        pinned: isPin,
                        actor: await utils.whatsapp.getSenderName({ ...update, key }),
                    });
                }
                continue;
            }
            if (typeof update.status !== 'undefined' && key.fromMe &&
                [WAMessageStatus.READ, WAMessageStatus.PLAYED].includes(update.status)) {
                state.dcClient.emit('whatsappRead', {
                    id: key.id,
                    jid: await utils.whatsapp.getChannelJid({ key }),
                });
            }

            const protocol = update.message?.protocolMessage;
            const isDelete =
                protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE ||
                update.messageStubType === WAMessageStubType.REVOKE;
            if (!isDelete) continue;
            const msgKey = protocol?.key || key;
            if (!utils.whatsapp.inWhitelist({ key: msgKey })) continue;
            state.dcClient.emit('whatsappDelete', {
                id: msgKey.id,
                jid: await utils.whatsapp.getChannelJid({ key: msgKey }),
            });
        }
    });

    client.ev.on('call', async (calls) => {
        for await (const call of calls) {
            if (!utils.whatsapp.inWhitelist(call) || !utils.whatsapp.sentAfterStart(call))
                return;

            state.dcClient.emit('whatsappCall', {
                jid: await utils.whatsapp.getChannelJid(call),
                call,
            });
            const ts = utils.whatsapp.getTimestamp(call);
            if (ts > state.startTime) state.startTime = ts;
        }
    });

    client.ev.on('contacts.update', async (contacts) => {
        for await (const contact of contacts) {
            if (typeof contact.imgUrl === 'undefined') continue;
            if (!utils.whatsapp.inWhitelist({ chatId: contact.id })) continue;

            utils.whatsapp._profilePicsCache[contact.id] = await client.profilePictureUrl(contact.id, 'preview').catch(() => null);

            if (!state.settings.ChangeNotifications) continue;
            const removed = utils.whatsapp._profilePicsCache[contact.id] === null;
            state.dcClient.emit('whatsappMessage', {
                id: null,
                name: "WA2DC",
                content: "[BOT] " + (removed ? "User removed their profile picture!" : "User changed their profile picture!"),
                profilePic: utils.whatsapp._profilePicsCache[contact.id],
                channelJid: await utils.whatsapp.getChannelJid({ chatId: contact.id }),
                isGroup: contact.id.endsWith('@g.us'),
                isForwarded: false,
                file: removed ? null : await client.profilePictureUrl(contact.id, 'image').catch(() => null),
            });
        }
    });

    client.ws.on(`CB:notification,type:status,set`, async (update) => {
        if (!utils.whatsapp.inWhitelist({ chatId: update.attrs.from })) return;

        if (!state.settings.ChangeNotifications) return;
        const status = update.content[0]?.content?.toString();
        if (!status) return;
        state.dcClient.emit('whatsappMessage', {
            id: null,
            name: "WA2DC",
            content: "[BOT] User changed their status to: " + status,
            profilePic: utils.whatsapp._profilePicsCache[update.attrs.from],
            channelJid: await utils.whatsapp.getChannelJid({ chatId: update.attrs.from }),
            isGroup: update.attrs.from.endsWith('@g.us'),
            isForwarded: false,
        });
    });

    client.ev.on('discordMessage', async ({ jid, message, forwardContext }) => {
        if (!allowsDiscordToWhatsApp()) {
            return;
        }

        const targetJid = normalizeSendJid(jid);
        const isNewsletterChat = isNewsletterJid(targetJid);
        const isForwardedFromDiscord = Boolean(forwardContext?.isForwarded);
        const options = buildSendOptionsForJid(targetJid);
        const forwardSnapshot = isForwardedFromDiscord && message?.wa2dcForwardSnapshot
            ? message.wa2dcForwardSnapshot
            : null;
        const snapshotEmbeds = Array.isArray(forwardSnapshot?.embeds) ? forwardSnapshot.embeds : [];

        if (!isForwardedFromDiscord && message.reference && !isNewsletterChat) {
            options.quoted = await utils.whatsapp.createQuoteMessage(message, targetJid);
            if (options.quoted == null) {
                message.channel.send(`Couldn't find the message quoted. You can only reply to last ${state.settings.lastMessageStorage} messages. Sending the message without the quoted message.`);
            }
        }

        const emojiData = utils.discord.extractCustomEmojiData(message);
        const hasOnlyCustomEmoji = emojiData.matches.length > 0 && emojiData.rawWithoutEmoji.trim() === '';
        const emojiFallbackText = emojiData.matches.map((entry) => `:${entry.name}:`).join(' ');
        const embedMirroringEnabled = Boolean(state.settings.DiscordEmbedsToWhatsApp);

        const baseText = message.content ?? message.cleanContent ?? '';
        let text = utils.whatsapp.convertDiscordFormatting(baseText);
        if (isForwardedFromDiscord && !text && typeof forwardSnapshot?.content === 'string') {
            text = utils.whatsapp.convertDiscordFormatting(forwardSnapshot.content);
        }
        const embedTextSegments = [];
        if (embedMirroringEnabled && typeof utils.discord.extractEmbedText === 'function') {
            const messageEmbedTextRaw = utils.discord.extractEmbedText(message, { includeUrls: true });
            if (messageEmbedTextRaw) {
                embedTextSegments.push(messageEmbedTextRaw);
            }
            if (snapshotEmbeds.length) {
                const snapshotEmbedTextRaw = utils.discord.extractEmbedText(snapshotEmbeds, { includeUrls: true });
                if (snapshotEmbedTextRaw && !embedTextSegments.includes(snapshotEmbedTextRaw)) {
                    embedTextSegments.push(snapshotEmbedTextRaw);
                }
            }
        }
        const embedTextRaw = embedTextSegments.join('\n\n');
        const embedText = embedTextRaw ? utils.whatsapp.convertDiscordFormatting(embedTextRaw) : '';
        if (embedText) {
            text = text ? `${text}\n${embedText}` : embedText;
        }
        const hasReplyReference = !isForwardedFromDiscord && message.reference;
        if (hasReplyReference) {
            text = text.replace(DISCORD_REPLY_PREFIX_REGEX, '');
        }
        if (text && typeof text.normalize === 'function') {
            text = text.normalize('NFKC');
        }

        const stripped = utils.discord.stripCustomEmojiCodes(text).trim();
        let composedText = stripped;

        if (state.settings.DiscordPrefix) {
            const prefix = state.settings.DiscordPrefixText || message.member?.displayName || message.author.username;
            composedText = stripped ? `*${prefix}*\n${stripped}` : `*${prefix}*`;
        }

        const urlEnforcement = utils.discord.ensureExplicitUrlScheme(composedText);
        text = urlEnforcement.text;

        const media = utils.discord.collectMessageMedia(message, {
            includeEmojiAttachments: emojiData.matches.length > 0,
            emojiMatches: emojiData.matches,
            includeEmbedAttachments: embedMirroringEnabled,
        });
        const normalizeAttachmentUrl = (value = '') => {
            if (typeof utils.discord.normalizeAttachmentUrl === 'function') {
                return utils.discord.normalizeAttachmentUrl(value);
            }
            return typeof value === 'string' ? value : '';
        };
        let attachments = [...(media.attachments || [])];
        const hasAttachmentUrl = (url) => {
            const normalizedUrl = normalizeAttachmentUrl(url);
            if (!normalizedUrl) return false;
            return attachments.some((existing) => normalizeAttachmentUrl(existing?.url) === normalizedUrl);
        };
        const snapshotEmbedMedia = embedMirroringEnabled && snapshotEmbeds.length
            ? utils.discord.collectMessageMedia({ embeds: snapshotEmbeds }, { includeEmbedAttachments: true })
            : { attachments: [], consumedUrls: [] };
        for (const snapshotEmbedAttachment of (snapshotEmbedMedia.attachments || [])) {
            const url = typeof snapshotEmbedAttachment?.url === 'string' ? snapshotEmbedAttachment.url : '';
            if (!url) continue;
            if (hasAttachmentUrl(url)) continue;
            attachments.push(snapshotEmbedAttachment);
        }
        const snapshotAttachments = Array.isArray(forwardSnapshot?.attachments) ? forwardSnapshot.attachments : [];
        for (const snapshotAttachment of snapshotAttachments) {
            const url = typeof snapshotAttachment?.url === 'string' ? snapshotAttachment.url : '';
            if (!url) continue;
            if (hasAttachmentUrl(url)) continue;
            attachments.push({
                url,
                name: typeof snapshotAttachment?.name === 'string' && snapshotAttachment.name.trim()
                    ? snapshotAttachment.name.trim()
                    : 'forwarded-attachment',
                contentType: typeof snapshotAttachment?.contentType === 'string' && snapshotAttachment.contentType
                    ? snapshotAttachment.contentType
                    : 'application/octet-stream',
            });
        }
        if (typeof utils.discord.dedupeCollectedAttachments === 'function') {
            attachments = utils.discord.dedupeCollectedAttachments(attachments);
        }
        const consumedUrls = [...(media.consumedUrls || []), ...(snapshotEmbedMedia.consumedUrls || [])];
        const shouldSendAttachments = state.settings.UploadAttachments && attachments.length > 0;

        if (shouldSendAttachments && consumedUrls.length && text) {
            for (const consumed of consumedUrls) {
                if (!consumed) continue;
                const variants = [consumed, `<${consumed}>`];
                for (const variant of variants) {
                    text = text.split(variant).join(' ');
                }
            }
            text = text.replace(/\s{2,}/g, ' ').trim();
        }

        const replyMentionId = hasReplyReference ? message.mentions?.repliedUser?.id : null;
        const mentionTextCandidates = [
            message.content,
            message.cleanContent,
            forwardSnapshot?.content,
            embedTextRaw,
            embedText,
            text,
        ];
        const mentionResolution = await resolveDiscordTextMentionsForWhatsApp({
            message,
            text,
            jid: targetJid,
            textCandidates: mentionTextCandidates,
            replyMentionId,
        });
        text = mentionResolution.text;
        const mentionJids = mentionResolution.mentionJids;

        if (shouldSendAttachments) {
            let first = true;
            let sentAnyAttachment = false;
            let attemptedAttachmentSends = 0;
            for (const file of attachments) {
                const preparedFile = normalizeAttachmentForWhatsAppSend(file);
                const doc = utils.whatsapp.createDocumentContent(preparedFile);
                if (!doc) continue;
                attemptedAttachmentSends += 1;
                if (first) {
                    let captionText = hasOnlyCustomEmoji ? '' : text;
                    if (isForwardedFromDiscord) {
                        captionText = captionText ? `Forwarded\n${captionText}` : 'Forwarded';
                    }
                    if (captionText || mentionJids.length) doc.caption = captionText;
                    if (!isNewsletterChat && mentionJids.length) doc.mentions = mentionJids;
                }
                try {
                    const sentMessage = await client.sendMessage(targetJid, doc, first ? options : undefined);
                    mapDiscordMessageToWhatsAppMessage({
                        discordMessageId: message.id,
                        sentMessage,
                        isNewsletter: isNewsletterChat,
                    });
                    storeMessage(sentMessage);
                    if (isNewsletterChat) {
                        const ackErrorCode = await waitForNewsletterAckError(sentMessage?.key?.id);
                        if (ackErrorCode) {
                            clearFailedNewsletterMapping({
                                discordMessageId: message.id,
                                sentMessage,
                            });
                            state.logger?.warn?.({
                                jid: targetJid,
                                discordMessageId: message.id,
                                outboundId: sentMessage?.key?.id,
                                error: ackErrorCode,
                            }, 'Newsletter attachment send was rejected by WhatsApp ack');
                            continue;
                        }
                    }
                    sentAnyAttachment = true;
                } catch (err) {
                    state.logger?.error(err);
                }
                if (first) {
                    first = false;
                }
            }
            if (sentAnyAttachment) {
                return;
            }
            if (attemptedAttachmentSends > 0) {
                state.logger?.warn?.({
                    jid: targetJid,
                    discordMessageId: message.id,
                    attachments: attemptedAttachmentSends,
                }, 'All attachment sends failed; falling back to text/link send');
            }
        }

        const fallbackParts = [];
        if (text) {
            fallbackParts.push(text);
        } else if (hasOnlyCustomEmoji && emojiFallbackText) {
            fallbackParts.push(emojiFallbackText);
        }
        const attachmentLinks = attachments.map((file) => file.url).filter(Boolean);
        fallbackParts.push(...attachmentLinks);
        let finalText = fallbackParts.join(' ').trim();
        if (isForwardedFromDiscord) {
            finalText = finalText ? `Forwarded\n${finalText}` : 'Forwarded';
        }
        if (!finalText) {
            return;
        }

        const content = { text: finalText };
        if (!isNewsletterChat && mentionJids.length) {
            content.mentions = mentionJids;
        }
        let preview = null;
        if (!isNewsletterChat) {
            try {
                preview = await utils.whatsapp.generateLinkPreview(finalText, {
                    uploadImage: typeof client.waUploadToServer === 'function' ? client.waUploadToServer : undefined,
                    logger: state.logger,
                });
            } catch (err) {
                state.logger?.warn({ err }, 'Failed to generate Discord link preview payload');
            }
        }
        if (preview) {
            content.linkPreview = preview;
            options.getUrlInfo = () => preview;
        }

        try {
            const sent = await client.sendMessage(targetJid, content, options);
            mapDiscordMessageToWhatsAppMessage({
                discordMessageId: message.id,
                sentMessage: sent,
                isNewsletter: isNewsletterChat,
            });
            storeMessage(sent);
        } catch (err) {
            state.logger?.error(err);
            if (isNewsletterChat) {
                const metadata = typeof client.newsletterMetadata === 'function'
                    ? await client.newsletterMetadata('jid', targetJid).catch(() => null)
                    : null;
                const role = metadata?.viewer_metadata?.role || metadata?.viewerMetadata?.role;
                const roleHint = role && !['OWNER', 'ADMIN'].includes(role)
                    ? ` Current account role: ${role}.`
                    : '';
                await message.channel?.send(
                    `Couldn't send to WhatsApp channel ${targetJid}.${roleHint} Newsletters require OWNER/ADMIN posting rights and may reject some media types.`,
                ).catch(() => {});
            }
        }
    });

    client.ev.on('discordEdit', async ({ jid, message }) => {
        if (!allowsDiscordToWhatsApp()) {
            return;
        }

        const key = {
            id: state.lastMessages[message.id],
            fromMe: message.webhookId == null || message.author.username === 'You',
            remoteJid: jid,
        };

        if (jid.endsWith('@g.us')) {
            key.participant = utils.whatsapp.toJid(message.author.username);
        }

        const embedMirroringEnabled = Boolean(state.settings.DiscordEmbedsToWhatsApp);
        const embedTextRaw = embedMirroringEnabled && typeof utils.discord.extractEmbedText === 'function'
            ? utils.discord.extractEmbedText(message, { includeUrls: true })
            : '';

        let text = utils.whatsapp.convertDiscordFormatting(message.content ?? message.cleanContent);
        const embedText = embedTextRaw ? utils.whatsapp.convertDiscordFormatting(embedTextRaw) : '';
        if (embedText) {
            text = text ? `${text}\n${embedText}` : embedText;
        }
        if (message.reference) {
            text = text.replace(DISCORD_REPLY_PREFIX_REGEX, '');
        }
        if (text && typeof text.normalize === 'function') {
            text = text.normalize('NFKC');
        }
        if (state.settings.DiscordPrefix) {
            const prefix = state.settings.DiscordPrefixText || message.member?.nickname || message.author.username;
            text = `*${prefix}*\n${text}`;
        }

        const replyMentionId = message.reference ? message.mentions?.repliedUser?.id : null;
        const mentionTextCandidates = [message.content, message.cleanContent, embedTextRaw, embedText, text];
        const mentionResolution = await resolveDiscordTextMentionsForWhatsApp({
            message,
            text,
            jid,
            textCandidates: mentionTextCandidates,
            replyMentionId,
        });
        text = mentionResolution.text;
        const editMentions = mentionResolution.mentionJids;
        const editOptions = buildSendOptionsForJid(jid);
        try {
            const editMsg = await client.sendMessage(
                jid,
                {
                    text,
                    edit: key,
                    ...(editMentions.length ? { mentions: editMentions } : {}),
                },
                editOptions,
            );
            state.sentMessages.add(editMsg.key.id);
        } catch (err) {
            state.logger?.error(err);
            await message.channel.send("Couldn't edit the message on WhatsApp.");
        }
    });

    client.ev.on('discordReaction', async ({ jid, reaction, removed }) => {
        if (!allowsDiscordToWhatsApp()) {
            return;
        }

        const targetJid = normalizeSendJid(jid);
        const newsletterChat = isNewsletterJid(targetJid);
        const key = {
            id: state.lastMessages[reaction.message.id],
            fromMe: reaction.message.webhookId == null || reaction.message.author.username === 'You',
            remoteJid: targetJid,
        };

        if (targetJid.endsWith('@g.us')) {
            key.participant = utils.whatsapp.toJid(reaction.message.author.username);
        }

        if (newsletterChat) {
            const serverId = resolveNewsletterServerIdForDiscordMessage({
                discordMessageId: reaction?.message?.id,
                candidateId: key.id,
            });
            if (!serverId) {
                return;
            }
            if (typeof client.newsletterReactMessage !== 'function') {
                state.logger?.warn?.({ jid: targetJid }, 'newsletterReactMessage is unavailable on this WhatsApp client');
                return;
            }
            if (!isLikelyNewsletterServerId(serverId)) {
                await reaction?.message?.channel?.send(
                    'Could not resolve a newsletter server message ID for this reaction yet. Please try again in a few seconds.',
                ).catch(() => {});
                return;
            }

            try {
                await client.newsletterReactMessage(targetJid, serverId, removed ? undefined : reaction.emoji.name);
                state.sentReactions.add(serverId);
            } catch (err) {
                state.logger?.error(err);
                await reaction?.message?.channel?.send(
                    "Couldn't apply that reaction on the WhatsApp newsletter message.",
                ).catch(() => {});
            }
            return;
        }

        const reactionOptions = buildSendOptionsForJid(targetJid);
        try {
            const reactionMsg = await client.sendMessage(targetJid, {
                react: {
                    text: removed ? '' : reaction.emoji.name,
                    key,
                },
            }, reactionOptions);
            const messageId = reactionMsg.key.id;
            state.lastMessages[messageId] = true;
            state.sentMessages.add(messageId);
            state.sentReactions.add(key.id);
        } catch (err) {
            state.logger?.error(err);
        }
    });

    client.ev.on('discordDelete', async ({ jid, id, discordMessageId }) => {
        if (!allowsDiscordToWhatsApp()) {
            return;
        }

        const targetJid = normalizeSendJid(jid);
        const isNewsletterChat = isNewsletterJid(targetJid);
        const rawDeleteId = normalizeMessageId(id);
        const deleteId = isNewsletterChat
            ? resolveNewsletterServerIdForDiscordMessage({
                discordMessageId,
                candidateId: rawDeleteId,
            })
            : rawDeleteId;
        if (!targetJid || !deleteId) {
            return;
        }
        if (isNewsletterChat && !isLikelyNewsletterServerId(deleteId)) {
            state.logger?.warn?.({
                jid: targetJid,
                discordMessageId,
                id,
                resolvedId: deleteId,
            }, 'Skipping newsletter delete because no server message id could be resolved');
            return;
        }
        const deleteOptions = buildSendOptionsForJid(targetJid);
        try {
            await client.sendMessage(targetJid, {
                delete: {
                    remoteJid: targetJid,
                    id: deleteId,
                    fromMe: true,
                },
            }, deleteOptions);
        } catch (err) {
            state.logger?.error(err);
        }
    });

    return client;
};

const actions = {
    async start() {
        const baileyState = await useSQLiteAuthState();
        await ensureSignalStoreSupport(baileyState.state?.keys);
        authState = baileyState.state;
        saveState = baileyState.saveCreds;
        state.waClient = await connectToWhatsApp();
    },
};

export { connectToWhatsApp };
export default actions;
