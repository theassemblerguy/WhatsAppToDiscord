import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('WhatsApp mentions can be converted to linked Discord user mentions', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Unlinked WhatsApp mentions fall back to WhatsApp contact names', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = {};

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, 'Hi @Alice');
    assert.deepEqual(result.discordMentions, []);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked WhatsApp mentions use cached Discord names in name-target mode', async () => {
  const originalWaClient = state.waClient;
  const originalDcClient = state.dcClient;
  const originalGuildId = state.settings.GuildID;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';

    state.dcClient = {
      users: {
        cache: new Map([
          [discordUserId, { id: discordUserId, username: 'Panos' }],
        ]),
      },
      guilds: { cache: new Map() },
    };
    state.settings.GuildID = 'guild-1';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'name' });
    assert.equal(result.content, 'Hi @Panos');
    assert.deepEqual(result.discordMentions, []);
  } finally {
    state.waClient = originalWaClient;
    state.dcClient = originalDcClient;
    state.settings.GuildID = originalGuildId;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked mentions work when WhatsApp provides LID JIDs but message text contains the PN token', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';
    const discordUserId = '123456789012345678';

    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (jid) => (jid === lidJid ? pnJid : null),
        },
      },
    };

    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [lidJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked mentions resolve when mention links were saved with a leading + phone JID', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const legacyKey = '+14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [legacyKey]: discordUserId };

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked mentions ping when WhatsApp message text uses the contact name token', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @Alice',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked mentions resolve for LID mentions without mapping when the stored contact names match', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';
    const discordUserId = '123456789012345678';

    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    
    state.contacts[pnJid] = 'Alice';
    state.contacts[lidJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @Alice',
      contextInfo: { mentionedJid: [lidJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Discord user mentions can be converted to WhatsApp mentions via mention links', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const input = 'Hi @Bob';
    const result = await utils.whatsapp.applyDiscordMentionLinks(input, [
      { discordUserId, displayTokens: ['Bob'] },
    ]);

    assert.equal(result.text, 'Hi @Alice');
    assert.deepEqual(result.mentionJids, [pnJid]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Outgoing mention parsing supports phone-number tokens', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const mentions = utils.whatsapp.getMentionedJids('hello @+14155550123 and @14155550123!');
    assert.deepEqual([...new Set(mentions)].sort(), ['14155550123@s.whatsapp.net']);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

test('Discord mentions prefer PN JIDs when both PN and LID links exist', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.contacts[lidJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId, [lidJid]: discordUserId };

    const input = 'Hi <@123456789012345678>';
    const result = await utils.whatsapp.applyDiscordMentionLinks(input, [
      {
        discordUserId,
        rawTokens: ['<@123456789012345678>', '<@!123456789012345678>'],
        displayTokens: ['Alice'],
      },
    ], { chatJid: '123456789@g.us' });

    assert.equal(result.text, 'Hi @Alice');
    assert.deepEqual(result.mentionJids, [pnJid]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});
