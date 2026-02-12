import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

const stubWhatsappUtils = () => ({
  _profilePicsCache: {},
  sendQR() {},
  updateContacts() {},
  formatJid: (jid) => jid,
  hydrateJidPair: async (jid) => [jid, null],
  migrateLegacyJid() {},
  isPhoneJid: () => true,
  generateLinkPreview: async () => null,
  deleteSession: async () => {},
});

class FakeWhatsAppClient {
  constructor() {
    this.ev = new EventEmitter();
    this.contacts = {};
    this.signalRepository = {};
    this.ws = { on() {} };
  }

  async sendMessage() {
    return { key: { id: 'sent-1', remoteJid: 'jid@s.whatsapp.net' } };
  }

  async groupMetadata() {
    return null;
  }

  async groupFetchAllParticipating() {
    return {};
  }
}

const waitFor = async (predicate, { timeoutMs = 750, intervalMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  
  while (true) {
    if (predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    
    await delay(intervalMs);
  }
};

test('connection.update ignores Discord send failures and still reconnects', async () => {
  const originalLogger = state.logger;
  const originalShutdownRequested = state.shutdownRequested;
  const originalContacts = snapshotObject(state.contacts);
  const originalGetControlChannel = utils.discord.getControlChannel;
  const originalWhatsappUtils = utils.whatsapp;

  try {
    state.logger = { info() {}, error() {}, warn() {}, debug() {} };
    state.shutdownRequested = false;
    restoreObject(state.contacts, {});

    let sendCalls = 0;
    const controlChannel = {
      send: async () => {
        sendCalls += 1;
        throw new Error('token unavailable');
      },
    };
    utils.discord.getControlChannel = async () => controlChannel;
    utils.whatsapp = stubWhatsappUtils();

    const createdClients = [];
    setClientFactoryOverrides({
      createWhatsAppClient: () => {
        const client = new FakeWhatsAppClient();
        createdClients.push(client);
        return client;
      },
      getBaileysVersion: async () => ({ version: [1, 0, 0] }),
    });

    const { connectToWhatsApp } = await import('../src/whatsappHandler.js');
    const client = await connectToWhatsApp(1);
    assert.equal(createdClients.length, 1);

    let unhandled;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.once('unhandledRejection', onUnhandled);

    client.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    const reconnected = await waitFor(() => createdClients.length >= 2, { timeoutMs: 1500 });
    process.removeListener('unhandledRejection', onUnhandled);

    assert.equal(unhandled, undefined);
    assert.ok(reconnected, `Expected reconnect attempt, but only saw ${createdClients.length} client(s).`);
    assert.ok(sendCalls >= 1);
  } finally {
    state.logger = originalLogger;
    state.shutdownRequested = originalShutdownRequested;
    restoreObject(state.contacts, originalContacts);
    utils.discord.getControlChannel = originalGetControlChannel;
    utils.whatsapp = originalWhatsappUtils;
    resetClientFactoryOverrides();
  }
});

test('connection.update no-ops during shutdown', async () => {
  const originalLogger = state.logger;
  const originalShutdownRequested = state.shutdownRequested;
  const originalContacts = snapshotObject(state.contacts);
  const originalGetControlChannel = utils.discord.getControlChannel;
  const originalWhatsappUtils = utils.whatsapp;

  try {
    state.logger = { info() {}, error() {}, warn() {}, debug() {} };
    state.shutdownRequested = false;
    restoreObject(state.contacts, {});

    let sendCalls = 0;
    const controlChannel = { send: async () => { sendCalls += 1; } };
    utils.discord.getControlChannel = async () => controlChannel;
    utils.whatsapp = stubWhatsappUtils();

    const createdClients = [];
    setClientFactoryOverrides({
      createWhatsAppClient: () => {
        const client = new FakeWhatsAppClient();
        createdClients.push(client);
        return client;
      },
      getBaileysVersion: async () => ({ version: [1, 0, 0] }),
    });

    const { connectToWhatsApp } = await import('../src/whatsappHandler.js');
    const client = await connectToWhatsApp(1);
    assert.equal(createdClients.length, 1);

    state.shutdownRequested = true;

    let unhandled;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.once('unhandledRejection', onUnhandled);

    client.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    await delay(50);
    process.removeListener('unhandledRejection', onUnhandled);

    assert.equal(unhandled, undefined);
    assert.equal(createdClients.length, 1);
    assert.equal(sendCalls, 0);
  } finally {
    state.logger = originalLogger;
    state.shutdownRequested = originalShutdownRequested;
    restoreObject(state.contacts, originalContacts);
    utils.discord.getControlChannel = originalGetControlChannel;
    utils.whatsapp = originalWhatsappUtils;
    resetClientFactoryOverrides();
  }
});
