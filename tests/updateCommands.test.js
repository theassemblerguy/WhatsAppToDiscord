import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import storage from '../src/storage.js';
import utils from '../src/utils.js';

await storage.ensureInitialized();

const importDiscordHandler = async (tag) => (
  (await import(`../src/discordHandler.js?test=${encodeURIComponent(tag)}`)).default
);

const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

const createInteraction = ({
  channelId,
  commandName = 'checkupdate',
  stringOptions = {},
  booleanOptions = {},
  integerOptions = {},
  numberOptions = {},
  channelOptions = {},
  userOptions = {},
}) => {
  const records = {
    deferReply: [],
    editReply: [],
    followUp: [],
    reply: [],
  };
  return {
    channelId,
    channel: { id: channelId },
    commandName,
    options: {
      getString: (name) => (name in stringOptions ? stringOptions[name] : null),
      getBoolean: (name) => (name in booleanOptions ? booleanOptions[name] : null),
      getInteger: (name) => (name in integerOptions ? integerOptions[name] : null),
      getNumber: (name) => (name in numberOptions ? numberOptions[name] : null),
      getChannel: (name) => (name in channelOptions ? channelOptions[name] : null),
      getUser: (name) => (name in userOptions ? userOptions[name] : null),
    },
    isButton: () => false,
    isCommand: () => true,
    isChatInputCommand: () => true,
    async deferReply(payload) {
      records.deferReply.push(payload);
    },
    async editReply(payload) {
      records.editReply.push(payload);
      return payload;
    },
    async followUp(payload) {
      records.followUp.push(payload);
      return payload;
    },
    async reply(payload) {
      records.reply.push(payload);
      return payload;
    },
    records,
  };
};

class FakeDiscordClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: 'bot-1' };
  }

  async login() {
    queueMicrotask(() => this.emit('ready'));
    return this;
  }
}

test('/checkupdate in control channel refreshes persistent prompt without duplicate full update reply', async () => {
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
    syncUpdatePrompt: utils.discord.syncUpdatePrompt,
    syncRollbackPrompt: utils.discord.syncRollbackPrompt,
  };
  const originalUpdater = {
    run: utils.updater.run,
    formatUpdateMessage: utils.updater.formatUpdateMessage,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
    ControlChannelID: state.settings.ControlChannelID,
  };
  const originalUpdateInfo = state.updateInfo;
  const originalDcClient = state.dcClient;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.settings.ControlChannelID = 'control';
    state.updateInfo = null;

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    const syncCalls = { update: 0, rollback: 0 };
    utils.discord.syncUpdatePrompt = async () => {
      syncCalls.update += 1;
    };
    utils.discord.syncRollbackPrompt = async () => {
      syncCalls.rollback += 1;
    };

    utils.updater.run = async () => {
      state.updateInfo = {
        currVer: '1.0.0',
        version: '1.1.0',
        channel: 'stable',
        changes: 'Fixes',
        canSelfUpdate: true,
      };
    };
    let formatCallCount = 0;
    utils.updater.formatUpdateMessage = () => {
      formatCallCount += 1;
      return 'UPDATE_MESSAGE';
    };

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('checkupdate-control');
    state.dcClient = await discordHandler.start();
    await delay(0);

    const interaction = createInteraction({ channelId: 'control', commandName: 'checkupdate' });
    fakeClient.emit('interactionCreate', interaction);
    await delay(0);

    assert.equal(syncCalls.update, 1);
    assert.equal(syncCalls.rollback, 1);
    assert.equal(formatCallCount, 0);
    assert.deepEqual(interaction.records.deferReply, [{ ephemeral: false }]);
    assert.equal(interaction.records.editReply.length, 1);
    assert.equal(
      interaction.records.editReply[0]?.content,
      'Update available. The persistent update prompt in this channel has been refreshed.',
    );
    assert.equal(interaction.records.followUp.length, 0);
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.syncUpdatePrompt = originalDiscordUtils.syncUpdatePrompt;
    utils.discord.syncRollbackPrompt = originalDiscordUtils.syncRollbackPrompt;
    utils.updater.run = originalUpdater.run;
    utils.updater.formatUpdateMessage = originalUpdater.formatUpdateMessage;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;
    state.settings.ControlChannelID = originalSettings.ControlChannelID;
    state.updateInfo = originalUpdateInfo;
    state.dcClient = originalDcClient;
    resetClientFactoryOverrides();
  }
});

test('/checkupdate outside control channel still returns full update details', async () => {
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
    syncUpdatePrompt: utils.discord.syncUpdatePrompt,
    syncRollbackPrompt: utils.discord.syncRollbackPrompt,
  };
  const originalUpdater = {
    run: utils.updater.run,
    formatUpdateMessage: utils.updater.formatUpdateMessage,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
    ControlChannelID: state.settings.ControlChannelID,
  };
  const originalUpdateInfo = state.updateInfo;
  const originalDcClient = state.dcClient;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.settings.ControlChannelID = 'control';
    state.updateInfo = null;

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    utils.discord.syncUpdatePrompt = async () => {};
    utils.discord.syncRollbackPrompt = async () => {};

    utils.updater.run = async () => {
      state.updateInfo = {
        currVer: '1.0.0',
        version: '1.1.0',
        channel: 'stable',
        changes: 'Fixes',
        canSelfUpdate: true,
      };
    };
    utils.updater.formatUpdateMessage = () => 'UPDATE_MESSAGE';

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('checkupdate-non-control');
    state.dcClient = await discordHandler.start();
    await delay(0);

    const interaction = createInteraction({ channelId: 'not-control', commandName: 'checkupdate' });
    fakeClient.emit('interactionCreate', interaction);
    await delay(0);

    assert.deepEqual(interaction.records.deferReply, [{ ephemeral: true }]);
    assert.equal(interaction.records.editReply.length, 1);
    assert.equal(interaction.records.editReply[0]?.content, 'UPDATE_MESSAGE');
    assert.ok(Array.isArray(interaction.records.editReply[0]?.components));
    assert.equal(interaction.records.editReply[0]?.components?.length, 1);
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.syncUpdatePrompt = originalDiscordUtils.syncUpdatePrompt;
    utils.discord.syncRollbackPrompt = originalDiscordUtils.syncRollbackPrompt;
    utils.updater.run = originalUpdater.run;
    utils.updater.formatUpdateMessage = originalUpdater.formatUpdateMessage;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;
    state.settings.ControlChannelID = originalSettings.ControlChannelID;
    state.updateInfo = originalUpdateInfo;
    state.dcClient = originalDcClient;
    resetClientFactoryOverrides();
  }
});

test('/newslettercreate succeeds when create response has null picture metadata', async () => {
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
    getOrCreateChannel: utils.discord.getOrCreateChannel,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
    ControlChannelID: state.settings.ControlChannelID,
    Whitelist: state.settings.Whitelist,
  };
  const originalDcClient = state.dcClient;
  const originalWaClient = state.waClient;
  const originalContacts = { ...state.contacts };

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.settings.ControlChannelID = 'control';
    state.settings.Whitelist = [];
    restoreObject(state.contacts, {});

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });

    const linkedJids = [];
    utils.discord.getOrCreateChannel = async (jid) => {
      linkedJids.push(jid);
      return { channelId: 'news-channel' };
    };

    let newsletterCreateCalls = 0;
    let rawQueryCalls = 0;
    state.waClient = {
      contacts: {},
      async newsletterCreate() {
        newsletterCreateCalls += 1;
        throw new Error('Expected raw WMex compatibility path instead of newsletterCreate()');
      },
      generateMessageTag() {
        return 'wmex-tag-1';
      },
      async query() {
        rawQueryCalls += 1;
        return {
          tag: 'iq',
          attrs: {},
          content: [{
            tag: 'result',
            attrs: {},
            content: Buffer.from(JSON.stringify({
              data: {
                xwa2_newsletter_create: {
                  id: '120363123456789012@newsletter',
                  thread_metadata: {
                    creation_time: '1730000000',
                    description: { text: 'Bridge test newsletter' },
                    invite: 'https://whatsapp.com/channel/test',
                    name: { text: 'Bridge Test' },
                    picture: null,
                    subscribers_count: '0',
                    verification: 'UNVERIFIED',
                  },
                  viewer_metadata: { mute: 'OFF' },
                },
              },
            }), 'utf-8'),
          }],
        };
      },
    };

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('newslettercreate-null-picture');
    state.dcClient = await discordHandler.start();
    await delay(0);

    const interaction = createInteraction({
      channelId: 'control',
      commandName: 'newslettercreate',
      stringOptions: {
        name: 'Bridge Test',
        description: 'Bridge test newsletter',
      },
    });
    fakeClient.emit('interactionCreate', interaction);
    await delay(0);

    assert.equal(rawQueryCalls, 1);
    assert.equal(newsletterCreateCalls, 0);
    assert.deepEqual(linkedJids, ['120363123456789012@newsletter']);
    assert.equal(state.contacts['120363123456789012@newsletter'], 'Bridge Test');
    assert.equal(state.waClient.contacts['120363123456789012@newsletter'], 'Bridge Test');
    assert.equal(interaction.records.editReply.length, 1);
    assert.equal(
      interaction.records.editReply[0]?.content,
      'Created newsletter `120363123456789012@newsletter` and linked it to <#news-channel>.',
    );
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;
    state.settings.ControlChannelID = originalSettings.ControlChannelID;
    state.settings.Whitelist = originalSettings.Whitelist;

    restoreObject(state.contacts, originalContacts);
    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    resetClientFactoryOverrides();
  }
});

test('/newsletterinviteinfo returns invite link/code from metadata', async () => {
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
    ControlChannelID: state.settings.ControlChannelID,
  };
  const originalDcClient = state.dcClient;
  const originalWaClient = state.waClient;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.settings.ControlChannelID = 'control';

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });

    state.waClient = {
      async newsletterMetadata(type, key) {
        assert.equal(type, 'jid');
        assert.equal(key, '120363123456789012@newsletter');
        return {
          id: key,
          name: 'Bridge Test',
          invite: 'https://whatsapp.com/channel/AbCdEfGhIjKlMnOp',
        };
      },
    };

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('newsletterinviteinfo-basic');
    state.dcClient = await discordHandler.start();
    await delay(0);

    const interaction = createInteraction({
      channelId: 'control',
      commandName: 'newsletterinviteinfo',
      stringOptions: {
        jid: '120363123456789012@newsletter',
      },
    });
    fakeClient.emit('interactionCreate', interaction);
    await delay(0);

    assert.equal(interaction.records.editReply.length, 1);
    const content = String(interaction.records.editReply[0]?.content || '');
    assert.ok(content.includes('Newsletter: `120363123456789012@newsletter`'));
    assert.ok(content.includes('Invite code: `AbCdEfGhIjKlMnOp`'));
    assert.ok(content.includes('Invite link: https://whatsapp.com/channel/AbCdEfGhIjKlMnOp'));
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;
    state.settings.ControlChannelID = originalSettings.ControlChannelID;

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    resetClientFactoryOverrides();
  }
});

test('/poll in a newsletter-linked channel falls back to text payload', async () => {
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
    ControlChannelID: state.settings.ControlChannelID,
  };
  const originalDcClient = state.dcClient;
  const originalWaClient = state.waClient;
  const originalChats = { ...state.chats };

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.settings.ControlChannelID = 'control';
    restoreObject(state.chats, {
      '120363123456789012@newsletter': { channelId: 'newsletter-room' },
    });

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });

    let sentPayload = null;
    state.waClient = {
      async sendMessage(jid, content) {
        sentPayload = { jid, content };
        return {
          key: {
            id: 'poll-msg-1',
            remoteJid: jid,
          },
        };
      },
    };

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('poll-newsletter-text-fallback');
    state.dcClient = await discordHandler.start();
    await delay(0);

    const interaction = createInteraction({
      channelId: 'newsletter-room',
      commandName: 'poll',
      stringOptions: {
        question: 'Bridge poll?',
        options: 'Yes,No',
      },
      integerOptions: {
        select: 1,
      },
    });
    fakeClient.emit('interactionCreate', interaction);
    await delay(0);

    assert.equal(sentPayload?.jid, '120363123456789012@newsletter');
    assert.equal(typeof sentPayload?.content?.text, 'string');
    assert.ok(sentPayload?.content?.text?.includes('📊 Poll: Bridge poll?'));
    assert.ok(sentPayload?.content?.text?.includes('1. Yes'));
    assert.ok(sentPayload?.content?.text?.includes('2. No'));
    assert.equal(
      interaction.records.editReply[0]?.content,
      'Newsletter poll fallback sent as text (interactive poll payload rejected by WhatsApp).',
    );
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;
    state.settings.ControlChannelID = originalSettings.ControlChannelID;

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    restoreObject(state.chats, originalChats);
    resetClientFactoryOverrides();
  }
});
