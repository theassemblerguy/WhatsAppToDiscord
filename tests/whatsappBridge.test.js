import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import storage from '../src/storage.js';
import utils from '../src/utils.js';

await storage.ensureInitialized();

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};
const snapshotSet = (value) => Array.from(value);
const restoreSet = (target, snapshot) => {
  target.clear();
  snapshot.forEach((entry) => target.add(entry));
};

const setupWhatsAppHarness = async ({
  oneWay = 0b11,
  inWhitelist = () => true,
  sentAfterStart = () => true,
  getMessageType = () => 'conversation',
} = {}) => {
  const originalLogger = state.logger;
  const originalOneWay = state.settings.oneWay;
  const originalMirrorWAStatuses = state.settings.MirrorWAStatuses;
  const originalLastMessages = state.lastMessages;
  const originalStartTime = state.startTime;
  const originalSentMessages = snapshotSet(state.sentMessages);
  const originalSentReactions = snapshotSet(state.sentReactions);
  const originalSentPins = snapshotSet(state.sentPins);
  const originalChats = snapshotObject(state.chats);
  const originalContacts = snapshotObject(state.contacts);
  const originalDcClient = state.dcClient;
  const originalWaClient = state.waClient;
  const originalGetControlChannel = utils.discord.getControlChannel;
  const originalWhatsappUtils = utils.whatsapp;

  try {
    state.logger = { info() {}, error() {}, warn() {}, debug() {} };
    state.settings.oneWay = oneWay;
    state.lastMessages = {};
    state.startTime = 0;
    state.sentMessages.clear();
    state.sentReactions.clear();
    state.sentPins.clear();
    restoreObject(state.chats, {});
    restoreObject(state.contacts, {});

    const controlMessages = [];
    const controlChannel = { send: async (msg) => { controlMessages.push(msg); } };
    utils.discord.getControlChannel = async () => controlChannel;

    utils.whatsapp = {
      _profilePicsCache: {},
      sendQR() {},
      getId: (raw) => raw.key.id,
      getMessageType: (...args) => getMessageType(...args),
      inWhitelist: (...args) => inWhitelist(...args),
      sentAfterStart: (...args) => sentAfterStart(...args),
      isStatusBroadcast: (raw) => raw?.key?.remoteJid === 'status@broadcast',
      getMessage: (raw) => ['conversation', { text: raw.message }],
      getSenderName: async () => 'Tester',
      getContent: async (message) => ({ content: message.text, discordMentions: [] }),
      getQuote: async () => null,
      getFile: async () => null,
      getProfilePic: async () => null,
      getChannelJid: async (raw) => raw.key.remoteJid,
      isGroup: () => false,
      isForwarded: () => false,
      getTimestamp: () => Date.now(),
      formatJid: (jid) => jid,
      migrateLegacyJid: () => {},
      isLidJid: () => true,
      toJid: (value) => value,
      deleteSession: async () => {},
      getSenderJid: async (raw) => raw.key.remoteJid,
      getMentionedJids: (...args) => originalWhatsappUtils.getMentionedJids(...args),
      convertDiscordFormatting: (text) => text,
      createQuoteMessage: async () => null,
      createDocumentContent: () => ({}),
      jidToName: (jid) => jid,
      applyDiscordMentionLinks: (...args) => originalWhatsappUtils.applyDiscordMentionLinks(...args),
      preferMentionJidForChat: (...args) => originalWhatsappUtils.preferMentionJidForChat(...args),
      updateContacts() {},
      generateLinkPreview: async () => null,
    };

    const forwarded = {
      messages: [],
      reactions: [],
      deletes: [],
      pins: [],
    };
    state.dcClient = new EventEmitter();
    state.dcClient.on('whatsappMessage', (payload) => forwarded.messages.push(payload));
    state.dcClient.on('whatsappReaction', (payload) => forwarded.reactions.push(payload));
    state.dcClient.on('whatsappDelete', (payload) => forwarded.deletes.push(payload));
    state.dcClient.on('whatsappPin', (payload) => forwarded.pins.push(payload));

    class FakeWhatsAppClient {
      constructor() {
        this.ev = new EventEmitter();
        this.sendCalls = [];
        this._sendCounter = 0;
        this.contacts = {};
        this.signalRepository = {};
        this.ws = { on() {} };
      }

      async sendMessage(jid, content, options) {
        this.sendCalls.push({ jid, content, options });
        this._sendCounter += 1;
        return { key: { id: `sent-${this._sendCounter}`, remoteJid: jid } };
      }

      async groupFetchAllParticipating() {
        return {};
      }

      async profilePictureUrl() {
        return null;
      }
    }

    const fakeClient = new FakeWhatsAppClient();
    setClientFactoryOverrides({
      createWhatsAppClient: () => fakeClient,
      getBaileysVersion: async () => ({ version: [1, 0, 0] }),
    });

    const { connectToWhatsApp } = await import('../src/whatsappHandler.js');
    await connectToWhatsApp();

    fakeClient.ev.emit('connection.update', { connection: 'open' });

    const cleanup = () => {
      state.logger = originalLogger;
      state.settings.oneWay = originalOneWay;
      state.settings.MirrorWAStatuses = originalMirrorWAStatuses;
      state.lastMessages = originalLastMessages;
      state.startTime = originalStartTime;
      restoreSet(state.sentMessages, originalSentMessages);
      restoreSet(state.sentReactions, originalSentReactions);
      restoreSet(state.sentPins, originalSentPins);
      restoreObject(state.chats, originalChats);
      restoreObject(state.contacts, originalContacts);
      state.dcClient = originalDcClient;
      state.waClient = originalWaClient;
      utils.discord.getControlChannel = originalGetControlChannel;
      utils.whatsapp = originalWhatsappUtils;
      resetClientFactoryOverrides();
    };

    return {
      fakeClient,
      forwarded,
      controlMessages,
      cleanup,
    };
  } catch (err) {
    state.logger = originalLogger;
    state.settings.oneWay = originalOneWay;
    state.settings.MirrorWAStatuses = originalMirrorWAStatuses;
    state.lastMessages = originalLastMessages;
    state.startTime = originalStartTime;
    restoreSet(state.sentMessages, originalSentMessages);
    restoreSet(state.sentReactions, originalSentReactions);
    restoreSet(state.sentPins, originalSentPins);
    restoreObject(state.chats, originalChats);
    restoreObject(state.contacts, originalContacts);
    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    utils.discord.getControlChannel = originalGetControlChannel;
    utils.whatsapp = originalWhatsappUtils;
    resetClientFactoryOverrides();
    throw err;
  }
};

test('WhatsApp message emits Discord event', async () => {
  const harness = await setupWhatsAppHarness();
  try {
    harness.fakeClient.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'abc', remoteJid: 'jid@s.whatsapp.net' },
        message: 'hello world',
      }],
    });

    await delay(0);

    assert.equal(harness.forwarded.messages[0]?.id, 'abc');
    assert.equal(harness.forwarded.messages[0]?.content, 'hello world');
    assert.equal(harness.forwarded.messages[0]?.channelJid, 'jid@s.whatsapp.net');
    assert.ok(harness.controlMessages.length >= 1);
  } finally {
    harness.cleanup();
  }
});

test('WhatsApp whitelist gating prevents emitting Discord events', async () => {
  const harness = await setupWhatsAppHarness({
    inWhitelist: () => false,
  });
  try {
    harness.fakeClient.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'blocked', remoteJid: 'jid@s.whatsapp.net' },
        message: 'should not forward',
      }],
    });
    await delay(0);
    assert.equal(harness.forwarded.messages.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('WhatsApp Status messages are skipped when status mirroring is disabled', async () => {
  const harness = await setupWhatsAppHarness();
  const originalMirrorWAStatuses = state.settings.MirrorWAStatuses;
  try {
    state.settings.MirrorWAStatuses = false;
    harness.fakeClient.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'status-1', remoteJid: 'status@broadcast' },
        message: 'status update',
      }],
    });

    await delay(0);

    assert.equal(harness.forwarded.messages.length, 0);
  } finally {
    state.settings.MirrorWAStatuses = originalMirrorWAStatuses;
    harness.cleanup();
  }
});

test('WhatsApp sentMessages prevents echoing messages back to Discord', async () => {
  const harness = await setupWhatsAppHarness();
  try {
    state.sentMessages.add('echo-id');
    harness.fakeClient.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'echo-id', remoteJid: 'jid@s.whatsapp.net' },
        message: 'echo loop',
      }],
    });
    await delay(0);
    assert.equal(harness.forwarded.messages.length, 0);
    assert.equal(state.sentMessages.has('echo-id'), false);
  } finally {
    harness.cleanup();
  }
});

test('WhatsApp sentReactions prevents echoing reactions back to Discord', async () => {
  const harness = await setupWhatsAppHarness();
  try {
    state.sentReactions.add('react-id');
    harness.fakeClient.ev.emit('messages.reaction', [{
      key: { id: 'react-id', remoteJid: 'jid@s.whatsapp.net', fromMe: false },
      reaction: { text: '👍' },
    }]);
    await delay(0);
    assert.equal(harness.forwarded.reactions.length, 0);
    assert.equal(state.sentReactions.has('react-id'), false);
  } finally {
    harness.cleanup();
  }
});

test('WhatsApp sentPins prevents echoing pins back to Discord', async () => {
  const harness = await setupWhatsAppHarness();
  try {
    state.sentPins.add('pinned-id');
    harness.fakeClient.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'pin-notice', remoteJid: 'jid@s.whatsapp.net' },
        message: {
          pinInChatMessage: {
            key: { id: 'pinned-id', remoteJid: 'jid@s.whatsapp.net' },
            type: 1,
          },
        },
      }],
    });
    await delay(0);
    assert.equal(harness.forwarded.pins.length, 0);
    assert.equal(state.sentPins.has('pinned-id'), false);

    const deleteCalls = harness.fakeClient.sendCalls.filter((call) => call.content?.delete);
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0].content.delete.id, 'pin-notice');
  } finally {
    harness.cleanup();
  }
});

test('Discord delete/edit/reaction events send the expected WhatsApp actions', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  try {
    state.lastMessages['dc-msg'] = 'wa-msg';

    harness.fakeClient.ev.emit('discordDelete', { jid: 'jid@s.whatsapp.net', id: 'wa-msg' });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls[0].content.delete.id, 'wa-msg');

    harness.fakeClient.sendCalls.length = 0;

    harness.fakeClient.ev.emit('discordEdit', {
      jid: 'jid@s.whatsapp.net',
      message: {
        id: 'dc-msg',
        cleanContent: 'edited',
        content: 'edited',
        webhookId: null,
        author: { username: 'You' },
        channel: { send: async () => {} },
      },
    });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls[0].content.edit.id, 'wa-msg');

    harness.fakeClient.sendCalls.length = 0;
    state.lastMessages['dc-react'] = 'wa-react-target';
    harness.fakeClient.ev.emit('discordReaction', {
      jid: 'jid@s.whatsapp.net',
      removed: false,
      reaction: {
        emoji: { name: '🔥' },
        message: {
          id: 'dc-react',
          webhookId: null,
          author: { username: 'You' },
        },
      },
    });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls[0].content.react.key.id, 'wa-react-target');
    assert.equal(state.sentReactions.has('wa-react-target'), true);
  } finally {
    harness.cleanup();
  }
});

test('Discord to WhatsApp sends include broadcast mode for broadcast chats', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  try {
    state.lastMessages['dc-broadcast-edit'] = 'wa-broadcast-msg';
    state.lastMessages['dc-broadcast-react'] = 'wa-broadcast-msg';

    harness.fakeClient.ev.emit('discordMessage', {
      jid: '12345678@broadcast',
      message: {
        id: 'dc-broadcast-message',
        content: 'broadcast text',
        cleanContent: 'broadcast text',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls[0]?.options?.broadcast, true);

    harness.fakeClient.ev.emit('discordEdit', {
      jid: '12345678@broadcast',
      message: {
        id: 'dc-broadcast-edit',
        cleanContent: 'edited',
        content: 'edited',
        webhookId: null,
        author: { username: 'You' },
        channel: { send: async () => {} },
      },
    });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls[1]?.options?.broadcast, true);

    harness.fakeClient.ev.emit('discordReaction', {
      jid: '12345678@broadcast',
      removed: false,
      reaction: {
        emoji: { name: '🔥' },
        message: {
          id: 'dc-broadcast-react',
          webhookId: null,
          author: { username: 'You' },
        },
      },
    });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls[2]?.options?.broadcast, true);

    harness.fakeClient.ev.emit('discordDelete', {
      jid: '12345678@broadcast',
      id: 'wa-broadcast-msg',
    });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls[3]?.options?.broadcast, true);
  } finally {
    harness.cleanup();
  }
});

test('Discord raw user and role mentions are converted before forwarding to WhatsApp', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  try {
    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      message: {
        id: 'dc-mention-msg',
        content: 'Hi <@123456789012345678> and <@&987654321098765432>',
        cleanContent: 'Hi @Panos and @Moderators',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        mentions: {
          users: new Map([
            ['123456789012345678', {
              id: '123456789012345678',
              username: 'panos-discord',
              globalName: 'Panos',
            }],
          ]),
          members: new Map([
            ['123456789012345678', { displayName: 'Panos' }],
          ]),
          roles: new Map([
            ['987654321098765432', { id: '987654321098765432', name: 'Moderators' }],
          ]),
        },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, 'Hi @Panos and @Moderators');
  } finally {
    harness.cleanup();
  }
});

test('Discord embeds are ignored when DiscordEmbedsToWhatsApp is disabled', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
  try {
    state.settings.DiscordEmbedsToWhatsApp = false;

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      message: {
        id: 'dc-embed-disabled',
        content: 'base text',
        cleanContent: 'base text',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [{
          title: 'Embed Title',
          description: 'Embed body',
          url: 'https://example.com/embed',
        }],
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls.length, 1);
    assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, 'base text');
  } finally {
    state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
    harness.cleanup();
  }
});

test('Discord embeds can be mirrored to WhatsApp with mention conversion', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
  const originalMentionLinks = { ...(state.settings.WhatsAppDiscordMentionLinks || {}) };
  const originalContacts = snapshotObject(state.contacts);
  try {
    state.settings.DiscordEmbedsToWhatsApp = true;
    const linkedJid = '14155550123@s.whatsapp.net';
    state.contacts[linkedJid] = 'Panos';
    state.settings.WhatsAppDiscordMentionLinks = { [linkedJid]: '123456789012345678' };

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      message: {
        id: 'dc-embed-enabled',
        content: '',
        cleanContent: '',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [{
          title: 'Embed Title',
          description: 'Hi <@123456789012345678> and <@&987654321098765432>',
          fields: [{ name: 'Scope', value: '<@123456789012345678>' }],
          url: 'https://example.com/embed',
        }],
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
        client: {
          users: {
            fetch: async (id) => (id === '123456789012345678'
              ? { id, username: 'panos-discord', globalName: 'Panos' }
              : null),
          },
        },
        guild: {
          members: {
            cache: new Map(),
            fetch: async (id) => (id === '123456789012345678' ? { id, displayName: 'Panos' } : null),
          },
          roles: {
            cache: new Map(),
            fetch: async (id) => (id === '987654321098765432' ? { id, name: 'Moderators' } : null),
          },
        },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls.length, 1);
    const mirrored = harness.fakeClient.sendCalls[0]?.content?.text || '';
    assert.ok(mirrored.includes('Embed Title'));
    assert.ok(mirrored.includes('Hi @14155550123 and @Moderators'));
    assert.ok(mirrored.includes('Scope: @14155550123'));
    assert.ok(mirrored.includes('https://example.com/embed'));
    assert.deepEqual(harness.fakeClient.sendCalls[0]?.content?.mentions, [linkedJid]);
  } finally {
    state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
    state.settings.WhatsAppDiscordMentionLinks = originalMentionLinks;
    restoreObject(state.contacts, originalContacts);
    harness.cleanup();
  }
});

test('Discord embed images are not duplicated when CDN and proxy URLs point to the same media', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
  try {
    state.settings.DiscordEmbedsToWhatsApp = true;
    utils.whatsapp.createDocumentContent = (attachment) => ({
      document: { url: attachment.url },
      fileName: attachment.name,
      mimetype: attachment.contentType,
    });

    const cdnUrl = 'https://cdn.discordapp.com/attachments/123/456/embed-image.png?ex=abc&is=def&hm=123';
    const proxyUrl = 'https://media.discordapp.net/attachments/123/456/embed-image.png?width=1024&height=768';
    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      message: {
        id: 'dc-embed-image-dedupe',
        content: '',
        cleanContent: '',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map([
          ['attachment-1', {
            id: 'attachment-1',
            url: cdnUrl,
            name: 'upload.png',
            contentType: 'image/png',
          }],
        ]),
        stickers: new Map(),
        embeds: [{
          title: 'Embed Image',
          image: {
            url: cdnUrl,
            proxy_url: proxyUrl,
          },
        }],
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls.length, 1);
    assert.equal(harness.fakeClient.sendCalls[0]?.content?.document?.url, cdnUrl);
  } finally {
    state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
    harness.cleanup();
  }
});

test('Discord replies warn with interpolated message storage size when quoted message is missing', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  const originalLimit = state.settings.lastMessageStorage;
  try {
    state.settings.lastMessageStorage = 321;
    const channelWarnings = [];
    let quoteAttempts = 0;
    utils.whatsapp.createQuoteMessage = async (...args) => {
      quoteAttempts += 1;
      assert.equal(args[1], 'jid@s.whatsapp.net');
      return null;
    };

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      message: {
        id: 'dc-reply-msg',
        content: 'reply text',
        cleanContent: 'reply text',
        reference: { channelId: 'chan-1', messageId: 'msg-1' },
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async (value) => { channelWarnings.push(value); } },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });

    await delay(0);

    assert.equal(quoteAttempts, 1);
    assert.equal(channelWarnings.length, 1);
    assert.ok(channelWarnings[0].includes('321'));
    assert.equal(channelWarnings[0].includes('${state.settings.lastMessageStorage}'), false);
  } finally {
    state.settings.lastMessageStorage = originalLimit;
    harness.cleanup();
  }
});

test('Discord forwarded messages skip quote lookup and send plain forwarded text to WhatsApp', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  try {
    const channelWarnings = [];
    let quoteAttempts = 0;
    utils.whatsapp.createQuoteMessage = async () => {
      quoteAttempts += 1;
      return null;
    };

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      forwardContext: { isForwarded: true, sourceChannelId: 'chan-a', sourceMessageId: 'm-1', sourceGuildId: 'guild-a' },
      message: {
        id: 'dc-forward-msg',
        content: '',
        cleanContent: '',
        reference: { channelId: 'chan-a', messageId: 'm-1' },
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async (value) => { channelWarnings.push(value); } },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });

    await delay(0);

    assert.equal(quoteAttempts, 0);
    assert.equal(channelWarnings.length, 0);
    assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, 'Forwarded');
  } finally {
    harness.cleanup();
  }
});

test('Discord forwarded snapshots mirror content and attachments to WhatsApp', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  try {
    utils.whatsapp.createDocumentContent = (attachment) => ({
      document: { url: attachment.url },
      fileName: attachment.name,
      mimetype: attachment.contentType,
    });

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      forwardContext: { isForwarded: true, sourceChannelId: 'chan-a', sourceMessageId: 'm-1', sourceGuildId: 'guild-a' },
      message: {
        id: 'dc-forward-snapshot',
        content: '',
        cleanContent: '',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        wa2dcForwardSnapshot: {
          content: 'snapshot text',
          attachments: [{
            url: 'https://cdn.discordapp.com/attachments/file.png',
            name: 'file.png',
            contentType: 'image/png',
          }],
        },
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls.length, 1);
    assert.equal(harness.fakeClient.sendCalls[0]?.content?.document?.url, 'https://cdn.discordapp.com/attachments/file.png');
    assert.equal(harness.fakeClient.sendCalls[0]?.content?.caption, 'Forwarded\nsnapshot text');
  } finally {
    harness.cleanup();
  }
});

test('Discord forwarded snapshot embeds can be mirrored to WhatsApp', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
  try {
    state.settings.DiscordEmbedsToWhatsApp = true;
    utils.whatsapp.createDocumentContent = (attachment) => ({
      document: { url: attachment.url },
      fileName: attachment.name,
      mimetype: attachment.contentType,
    });

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      forwardContext: { isForwarded: true, sourceChannelId: 'chan-a', sourceMessageId: 'm-1', sourceGuildId: 'guild-a' },
      message: {
        id: 'dc-forward-snapshot-embed',
        content: '',
        cleanContent: '',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        wa2dcForwardSnapshot: {
          content: '',
          attachments: [],
          embeds: [{
            title: 'Snapshot Embed',
            description: 'embed body',
            url: 'https://example.com/embed',
            image: {
              url: 'https://cdn.discordapp.com/attachments/snapshot-embed.png',
            },
          }],
        },
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls.length, 1);
    const sent = harness.fakeClient.sendCalls[0]?.content || {};
    assert.equal(sent.document?.url, 'https://cdn.discordapp.com/attachments/snapshot-embed.png');
    assert.equal(sent.caption, 'Forwarded\nSnapshot Embed\nembed body\nhttps://example.com/embed');
  } finally {
    state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
    harness.cleanup();
  }
});

test('Discord forwarded snapshot embeds do not duplicate attachment media', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  const originalEmbedSetting = state.settings.DiscordEmbedsToWhatsApp;
  try {
    state.settings.DiscordEmbedsToWhatsApp = true;
    utils.whatsapp.createDocumentContent = (attachment) => ({
      document: { url: attachment.url },
      fileName: attachment.name,
      mimetype: attachment.contentType,
    });

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      forwardContext: { isForwarded: true, sourceChannelId: 'chan-a', sourceMessageId: 'm-1', sourceGuildId: 'guild-a' },
      message: {
        id: 'dc-forward-snapshot-embed-dedupe',
        content: '',
        cleanContent: '',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        wa2dcForwardSnapshot: {
          content: '',
          attachments: [{
            url: 'https://cdn.discordapp.com/attachments/123/456/snapshot-embed.png?ex=abc&is=def&hm=123',
            name: 'snapshot-embed.png',
            contentType: 'image/png',
          }],
          embeds: [{
            title: 'Snapshot Embed',
            image: {
              proxyURL: 'https://media.discordapp.net/attachments/123/456/snapshot-embed.png?width=1024&height=1024',
            },
          }],
        },
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls.length, 1);
    assert.ok(harness.fakeClient.sendCalls[0]?.content?.document?.url);
  } finally {
    state.settings.DiscordEmbedsToWhatsApp = originalEmbedSetting;
    harness.cleanup();
  }
});

test('Discord forwarded snapshots resolve user and role mentions from raw tokens', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b11 });
  const originalMentionLinks = { ...(state.settings.WhatsAppDiscordMentionLinks || {}) };
  const originalContacts = snapshotObject(state.contacts);
  try {
    const linkedJid = '14155550123@s.whatsapp.net';
    state.contacts[linkedJid] = 'Panos';
    state.settings.WhatsAppDiscordMentionLinks = { [linkedJid]: '123456789012345678' };

    harness.fakeClient.ev.emit('discordMessage', {
      jid: 'jid@s.whatsapp.net',
      forwardContext: { isForwarded: true, sourceChannelId: 'chan-a', sourceMessageId: 'm-1', sourceGuildId: 'guild-a' },
      message: {
        id: 'dc-forward-mention-snapshot',
        content: '',
        cleanContent: '',
        webhookId: null,
        author: { username: 'BridgeUser' },
        member: { displayName: 'BridgeUser' },
        channel: { send: async () => {} },
        attachments: new Map(),
        stickers: new Map(),
        embeds: [],
        mentions: { users: new Map(), members: new Map(), roles: new Map() },
        wa2dcForwardSnapshot: {
          content: 'Hi <@123456789012345678> and <@&987654321098765432>',
          attachments: [],
        },
        client: {
          users: {
            fetch: async (id) => (id === '123456789012345678'
              ? { id, username: 'panos-discord', globalName: 'Panos' }
              : null),
          },
        },
        guild: {
          members: {
            cache: new Map(),
            fetch: async (id) => (id === '123456789012345678' ? { id, displayName: 'Panos' } : null),
          },
          roles: {
            cache: new Map(),
            fetch: async (id) => (id === '987654321098765432' ? { id, name: 'Moderators' } : null),
          },
        },
      },
    });

    await delay(0);

    assert.equal(harness.fakeClient.sendCalls.length, 1);
    assert.equal(harness.fakeClient.sendCalls[0]?.content?.text, 'Forwarded\nHi @14155550123 and @Moderators');
    assert.deepEqual(harness.fakeClient.sendCalls[0]?.content?.mentions, [linkedJid]);
  } finally {
    state.settings.WhatsAppDiscordMentionLinks = originalMentionLinks;
    restoreObject(state.contacts, originalContacts);
    harness.cleanup();
  }
});

test('oneWay gating blocks Discord -> WhatsApp sends', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b01 });
  try {
    harness.fakeClient.ev.emit('discordDelete', { jid: 'jid@s.whatsapp.net', id: 'wa-msg' });
    harness.fakeClient.ev.emit('discordEdit', {
      jid: 'jid@s.whatsapp.net',
      message: {
        id: 'dc-msg',
        cleanContent: 'edited',
        content: 'edited',
        webhookId: null,
        author: { username: 'You' },
        channel: { send: async () => {} },
      },
    });
    harness.fakeClient.ev.emit('discordReaction', {
      jid: 'jid@s.whatsapp.net',
      removed: false,
      reaction: {
        emoji: { name: '🔥' },
        message: {
          id: 'dc-react',
          webhookId: null,
          author: { username: 'You' },
        },
      },
    });
    await delay(0);
    assert.equal(harness.fakeClient.sendCalls.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('WhatsApp delete events emit whatsappDelete to Discord', async () => {
  const harness = await setupWhatsAppHarness();
  try {
    harness.fakeClient.ev.emit('messages.delete', { keys: [{ id: 'wa-del', remoteJid: 'jid@s.whatsapp.net' }] });
    await delay(0);
    assert.deepEqual(harness.forwarded.deletes, [{ id: 'wa-del', jid: 'jid@s.whatsapp.net' }]);
  } finally {
    harness.cleanup();
  }
});

test('WhatsApp edited messages are flagged as edits', async () => {
  const harness = await setupWhatsAppHarness({
    getMessageType: () => 'editedMessage',
  });
  try {
    harness.fakeClient.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'edit-id', remoteJid: 'jid@s.whatsapp.net' },
        message: 'edited hello',
      }],
    });
    await delay(0);
    assert.equal(harness.forwarded.messages[0]?.isEdit, true);
  } finally {
    harness.cleanup();
  }
});
