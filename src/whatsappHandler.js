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


let authState;
let saveState;
let groupCachePruneInterval = null;
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

const collectDiscordMentionData = (message, replyMentionId = null) => {
    const mentionDescriptors = [];
    const fallbackReplacements = [];

    const mentionedUsers = message?.mentions?.users ? [...message.mentions.users.values()] : [];
    for (const user of mentionedUsers) {
        if (!user?.id) continue;
        if (replyMentionId && user.id === replyMentionId) continue;
        const member = message?.mentions?.members?.get(user.id);
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
    }

    const mentionedRoles = message?.mentions?.roles ? [...message.mentions.roles.values()] : [];
    for (const role of mentionedRoles) {
        if (!role?.id) continue;
        const fallbackLabel = toMentionLabel(role.name);
        if (!fallbackLabel) continue;
        fallbackReplacements.push({
            rawTokens: [`<@&${role.id}>`],
            value: fallbackLabel,
        });
    }

    return { mentionDescriptors, fallbackReplacements };
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
            // avoid thrashing: back off further for this group
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
            // Baileys expects a map for each category; ensure the file exists so new
            // rc.8+ entries (like tctoken and lid-mapping) can be written safely.
            // eslint-disable-next-line no-await-in-loop
            const existing = await keyStore.get(key, []);
            if (existing == null) {
                // eslint-disable-next-line no-await-in-loop
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
                // eslint-disable-next-line no-await-in-loop
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
            // Baileys expects proto.Message for some features (e.g., poll decryption).
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
                // eslint-disable-next-line no-param-reassign
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
                const messageId = utils.whatsapp.getId(rawMessage);
                if (state.sentMessages.has(messageId)) {
                    state.sentMessages.delete(messageId);
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
                        isForwarded: utils.whatsapp.isForwarded(rawMessage.message),
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
                    isForwarded: utils.whatsapp.isForwarded(message),
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
                return;

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

    client.ev.on('messages.delete', async (updates) => {
        const keys = 'keys' in updates ? updates.keys : updates;
        for (const key of keys) {
            if (!utils.whatsapp.inWhitelist({ key })) continue;
            const jid = await utils.whatsapp.getChannelJid({ key });
            if (!jid) continue;
            state.dcClient.emit('whatsappDelete', {
                id: key.id,
                jid,
            });
        }
    });

    client.ev.on('messages.update', async (updates) => {
        for (const { update, key } of updates) {
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
        if ((state.settings.oneWay >> 1 & 1) === 0) {
            return;
        }

        const isForwardedFromDiscord = Boolean(forwardContext?.isForwarded);
        const options = {};

        if (!isForwardedFromDiscord && message.reference) {
            options.quoted = await utils.whatsapp.createQuoteMessage(message, jid);
            if (options.quoted == null) {
                message.channel.send(`Couldn't find the message quoted. You can only reply to last ${state.settings.lastMessageStorage} messages. Sending the message without the quoted message.`);
            }
        }

        const emojiData = utils.discord.extractCustomEmojiData(message);
        const hasOnlyCustomEmoji = emojiData.matches.length > 0 && emojiData.rawWithoutEmoji.trim() === '';
        const emojiFallbackText = emojiData.matches.map((entry) => `:${entry.name}:`).join(' ');

        let text = utils.whatsapp.convertDiscordFormatting(message.content ?? message.cleanContent ?? '');
        if (!isForwardedFromDiscord && message.reference) {
            // Discord prepends a mention to replies which results in all
            // participants being tagged on WhatsApp. Remove the leading
            // mention so no unintended mass mentions occur.
            text = text.replace(/^(<@!?\d+>|@\S+)\s*/, '');
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
        });
        const attachments = media.attachments || [];
        const consumedUrls = media.consumedUrls || [];
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

        const replyMentionId = !isForwardedFromDiscord && message.reference ? message.mentions?.repliedUser?.id : null;
        const { mentionDescriptors, fallbackReplacements } = collectDiscordMentionData(message, replyMentionId);

        const linkedMentions = typeof utils.whatsapp.applyDiscordMentionLinks === 'function'
            ? await utils.whatsapp.applyDiscordMentionLinks(text, mentionDescriptors, { chatJid: jid })
            : { text, mentionJids: [] };
        text = linkedMentions.text ?? text;
        text = replaceLiteralMentionTokens(text, fallbackReplacements);

        const mentionJidsRaw = [...new Set([
            ...linkedMentions.mentionJids,
            ...utils.whatsapp.getMentionedJids(text),
        ])];
        const mentionJids = [...new Set((await Promise.all(
            mentionJidsRaw.map((candidate) => utils.whatsapp.preferMentionJidForChat(candidate, jid)),
        )).filter(Boolean))];

        if (shouldSendAttachments) {
            let first = true;
            for (const file of attachments) {
                const doc = utils.whatsapp.createDocumentContent(file);
                if (!doc) continue;
                if (first) {
                    let captionText = hasOnlyCustomEmoji ? '' : text;
                    if (isForwardedFromDiscord) {
                        captionText = captionText ? `Forwarded\n${captionText}` : 'Forwarded';
                    }
                    if (captionText || mentionJids.length) doc.caption = captionText;
                    if (mentionJids.length) doc.mentions = mentionJids;
                }
                try {
                    const sentMessage = await client.sendMessage(jid, doc, first ? options : undefined);
                    state.lastMessages[message.id] = sentMessage.key.id;
                    state.lastMessages[sentMessage.key.id] = message.id;
                    state.sentMessages.add(sentMessage.key.id);
                    storeMessage(sentMessage);
                } catch (err) {
                    state.logger?.error(err);
                }
                if (first) {
                    first = false;
                }
            }
            return;
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
        if (mentionJids.length) {
            content.mentions = mentionJids;
        }
        let preview = null;
        try {
            preview = await utils.whatsapp.generateLinkPreview(finalText, {
                uploadImage: typeof client.waUploadToServer === 'function' ? client.waUploadToServer : undefined,
                logger: state.logger,
            });
        } catch (err) {
            state.logger?.warn({ err }, 'Failed to generate Discord link preview payload');
        }
        if (preview) {
            content.linkPreview = preview;
            options.getUrlInfo = () => preview;
        }

        try {
            const sent = await client.sendMessage(jid, content, options);
            state.lastMessages[message.id] = sent.key.id;
            state.lastMessages[sent.key.id] = message.id;
            state.sentMessages.add(sent.key.id);
            storeMessage(sent);
        } catch (err) {
            state.logger?.error(err);
        }
    });

    client.ev.on('discordEdit', async ({ jid, message }) => {
        if ((state.settings.oneWay >> 1 & 1) === 0) {
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

        let text = utils.whatsapp.convertDiscordFormatting(message.content ?? message.cleanContent);
        if (message.reference) {
            // Remove Discord's automatic reply mention to avoid tagging
            // every participant on WhatsApp when editing a reply.
            text = text.replace(/^(<@!?\d+>|@\S+)\s*/, '');
        }
        if (text && typeof text.normalize === 'function') {
            text = text.normalize('NFKC');
        }
        if (state.settings.DiscordPrefix) {
            const prefix = state.settings.DiscordPrefixText || message.member?.nickname || message.author.username;
            text = `*${prefix}*\n${text}`;
        }

        const replyMentionId = message.reference ? message.mentions?.repliedUser?.id : null;
        const { mentionDescriptors, fallbackReplacements } = collectDiscordMentionData(message, replyMentionId);

        const linkedMentions = typeof utils.whatsapp.applyDiscordMentionLinks === 'function'
            ? await utils.whatsapp.applyDiscordMentionLinks(text, mentionDescriptors, { chatJid: jid })
            : { text, mentionJids: [] };
        text = linkedMentions.text ?? text;
        text = replaceLiteralMentionTokens(text, fallbackReplacements);

        const editMentionsRaw = [...new Set([
            ...linkedMentions.mentionJids,
            ...utils.whatsapp.getMentionedJids(text),
        ])];
        const editMentions = [...new Set((await Promise.all(
            editMentionsRaw.map((candidate) => utils.whatsapp.preferMentionJidForChat(candidate, jid)),
        )).filter(Boolean))];
        try {
            const editMsg = await client.sendMessage(
                jid,
                {
                    text,
                    edit: key,
                    ...(editMentions.length ? { mentions: editMentions } : {}),
                }
            );
            state.sentMessages.add(editMsg.key.id);
        } catch (err) {
            state.logger?.error(err);
            await message.channel.send("Couldn't edit the message on WhatsApp.");
        }
    });

    client.ev.on('discordReaction', async ({ jid, reaction, removed }) => {
        if ((state.settings.oneWay >> 1 & 1) === 0) {
            return;
        }

        const key = {
            id: state.lastMessages[reaction.message.id],
            fromMe: reaction.message.webhookId == null || reaction.message.author.username === 'You',
            remoteJid: jid,
        };

        if (jid.endsWith('@g.us')) {
            key.participant = utils.whatsapp.toJid(reaction.message.author.username);
        }

        try {
            const reactionMsg = await client.sendMessage(jid, {
                react: {
                    text: removed ? '' : reaction.emoji.name,
                    key,
                },
            });
            const messageId = reactionMsg.key.id;
            state.lastMessages[messageId] = true;
            state.sentMessages.add(messageId);
            state.sentReactions.add(key.id);
        } catch (err) {
            state.logger?.error(err);
        }
    });

    client.ev.on('discordDelete', async ({ jid, id }) => {
        if ((state.settings.oneWay >> 1 & 1) === 0) {
            return;
        }

        try {
            await client.sendMessage(jid, {
                delete: {
                    remoteJid: jid,
                    id,
                    fromMe: true,
                },
            });
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
    const selectPnJid = (list = []) => list.find((jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')) || null;
