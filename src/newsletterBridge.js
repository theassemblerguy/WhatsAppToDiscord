import state from './state.js';

const NEWSLETTER_ACK_ERROR_TTL_MS = 30 * 1000;
const DEFAULT_NEWSLETTER_ACK_WAIT_MS = 1200;

const newsletterAckErrors = new Map();
const newsletterAckWaiters = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeBridgeMessageId = (value) => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return String(value || '').trim();
};

const BAILEYS_OUTBOUND_MESSAGE_ID_REGEX = /^3E[A-F0-9]{20,}$/i;

const isLikelyNewsletterServerId = (value) => {
  const normalized = normalizeBridgeMessageId(value);
  if (!normalized) return false;
  if (BAILEYS_OUTBOUND_MESSAGE_ID_REGEX.test(normalized)) {
    return false;
  }
  return true;
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
    const normalized = normalizeBridgeMessageId(candidate);
    if (normalized) return normalized;
  }
  return null;
};

const resolveNewsletterServerIdForDiscordMessage = (
  discordMessageId,
  fallbackId = null,
  lastMessages = state.lastMessages,
) => {
  const normalizedDiscordMessageId = normalizeBridgeMessageId(discordMessageId);
  const normalizedFallbackId = normalizeBridgeMessageId(fallbackId);
  const directLookup = normalizedDiscordMessageId && lastMessages
    ? normalizeBridgeMessageId(lastMessages[normalizedDiscordMessageId])
    : '';
  if (isLikelyNewsletterServerId(directLookup)) {
    return directLookup;
  }
  if (isLikelyNewsletterServerId(normalizedFallbackId)) {
    return normalizedFallbackId;
  }
  if (!normalizedDiscordMessageId || !lastMessages) {
    return normalizedFallbackId || null;
  }
  for (const [waId, dcId] of Object.entries(lastMessages)) {
    if (normalizeBridgeMessageId(dcId) !== normalizedDiscordMessageId) continue;
    if (isLikelyNewsletterServerId(waId)) {
      return normalizeBridgeMessageId(waId);
    }
  }
  return normalizedFallbackId || null;
};

const waitForNewsletterServerId = async ({
  discordMessageId,
  candidateId = null,
  timeoutMs = 8000,
  pollMs = 150,
  lastMessages = state.lastMessages,
} = {}) => {
  const immediate = resolveNewsletterServerIdForDiscordMessage(
    discordMessageId,
    candidateId,
    lastMessages,
  );
  if (isLikelyNewsletterServerId(immediate)) {
    return immediate;
  }
  if (!timeoutMs || timeoutMs <= 0) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(Math.max(1, pollMs));
    const resolved = resolveNewsletterServerIdForDiscordMessage(
      discordMessageId,
      candidateId,
      lastMessages,
    );
    if (isLikelyNewsletterServerId(resolved)) {
      return resolved;
    }
  }
  return null;
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
  const normalizedMessageId = normalizeBridgeMessageId(messageId);
  if (!normalizedMessageId) return;
  const normalizedError = normalizeBridgeMessageId(errorCode) || 'unknown';
  const normalizedJid = typeof jid === 'string' ? jid.trim() : normalizeBridgeMessageId(jid);
  pruneNewsletterAckErrors();
  newsletterAckErrors.set(normalizedMessageId, {
    errorCode: normalizedError,
    jid: normalizedJid || null,
    timestamp: Date.now(),
  });
  resolveNewsletterAckWaiters(normalizedMessageId, normalizedError);
};

const waitForNewsletterAckError = async (messageId, timeoutMs = DEFAULT_NEWSLETTER_ACK_WAIT_MS) => {
  const normalizedMessageId = normalizeBridgeMessageId(messageId);
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

export {
  getNewsletterServerIdFromMessage,
  isLikelyNewsletterServerId,
  normalizeBridgeMessageId,
  noteNewsletterAckError,
  resolveNewsletterServerIdForDiscordMessage,
  waitForNewsletterAckError,
  waitForNewsletterServerId,
};
