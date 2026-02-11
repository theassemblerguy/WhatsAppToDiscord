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
      getMentionedJids: () => [],
      convertDiscordFormatting: (text) => text,
      createQuoteMessage: async () => null,
      createDocumentContent: () => ({}),
      jidToName: (jid) => jid,
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

test('oneWay gating blocks Discord -> WhatsApp sends', async () => {
  const harness = await setupWhatsAppHarness({ oneWay: 0b01 }); // WhatsApp -> Discord only
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
