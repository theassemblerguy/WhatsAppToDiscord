import assert from "node:assert/strict";
import test from "node:test";
import messageStore from "../src/messageStore.js";
import state from "../src/state.js";
import utils from "../src/utils.js";
import initIsolatedStorage from "./helpers/initIsolatedStorage.js";

await initIsolatedStorage(import.meta.url);

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => {
		delete target[key];
	});
	Object.assign(target, snapshot);
};

test("getQuote prefers cached original message sender name", async () => {
	const originalWaClient = state.waClient;
	const originalContacts = snapshotObject(state.contacts);

	try {
		restoreObject(state.contacts, {});
		messageStore.cache.clear();

		state.waClient = {
			contacts: state.contacts,
			user: { id: "0@s.whatsapp.net" },
		};

		const chatJid = "12345@g.us";
		const stanzaId = "stanza-1";

		messageStore.set({
			key: {
				id: stanzaId,
				remoteJid: chatJid,
				fromMe: false,
				participant: "14155550123@s.whatsapp.net",
			},
			pushName: "Panagiotis",
			message: { conversation: "Μια δοκιμή θα κάνω μην δίνεις σημασία" },
		});

		const quote = await utils.whatsapp.getQuote({
			key: { remoteJid: chatJid, fromMe: false },
			message: {
				extendedTextMessage: {
					text: "Οκ",
					contextInfo: {
						stanzaId,
						participant: "67465430188278@lid",
						quotedMessage: {
							conversation: "Μια δοκιμή θα κάνω μην δίνεις σημασία",
						},
					},
				},
			},
		});

		assert.equal(quote?.name, "Panagiotis");
	} finally {
		state.waClient = originalWaClient;
		restoreObject(state.contacts, originalContacts);
		messageStore.cache.clear();
	}
});

test("getQuote resolves LID quote authors via lidMapping when available", async () => {
	const originalWaClient = state.waClient;
	const originalContacts = snapshotObject(state.contacts);

	try {
		restoreObject(state.contacts, {});
		messageStore.cache.clear();

		const pnJid = "14155550123@s.whatsapp.net";
		const lidJid = "67465430188278@lid";
		state.contacts[pnJid] = "Panagiotis";

		state.waClient = {
			contacts: state.contacts,
			user: { id: "0@s.whatsapp.net" },
			signalRepository: {
				lidMapping: {
					getPNForLID: async (jid) =>
						utils.whatsapp.formatJid(jid) === lidJid ? pnJid : null,
				},
			},
		};

		const quote = await utils.whatsapp.getQuote({
			key: { remoteJid: "12345@g.us", fromMe: false },
			message: {
				extendedTextMessage: {
					text: "Οκ",
					contextInfo: {
						stanzaId: "stanza-2",
						participant: lidJid,
						quotedMessage: {
							conversation: "Μια δοκιμή θα κάνω μην δίνεις σημασία",
						},
					},
				},
			},
		});

		assert.equal(quote?.name, "Panagiotis");
	} finally {
		state.waClient = originalWaClient;
		restoreObject(state.contacts, originalContacts);
		messageStore.cache.clear();
	}
});

test("getQuote falls back to messageContextInfo metadata for forwarded messages", async () => {
	const originalWaClient = state.waClient;
	const originalContacts = snapshotObject(state.contacts);

	try {
		restoreObject(state.contacts, {});
		messageStore.cache.clear();

		state.waClient = {
			contacts: state.contacts,
			user: { id: "0@s.whatsapp.net" },
			signalRepository: {},
		};

		const quote = await utils.whatsapp.getQuote({
			key: { remoteJid: "target@s.whatsapp.net", fromMe: false },
			message: {
				conversation: "Forwarded copy",
				messageContextInfo: {
					stanzaId: "orig-123",
					remoteJid: "source@s.whatsapp.net",
					participant: "14155550123@s.whatsapp.net",
					placeholderKey: {
						id: "orig-123",
						remoteJid: "source@s.whatsapp.net",
						participant: "14155550123@s.whatsapp.net",
					},
				},
			},
		});

		assert.equal(quote?.id, "orig-123");
		assert.equal(quote?.sourceJid, "source@s.whatsapp.net");
		assert.equal(quote?.content, "");
	} finally {
		state.waClient = originalWaClient;
		restoreObject(state.contacts, originalContacts);
		messageStore.cache.clear();
	}
});

test("isForwarded detects top-level messageContextInfo and nested contextInfo", () => {
	assert.equal(
		utils.whatsapp.isForwarded({ messageContextInfo: { isForwarded: true } }),
		true,
	);
	assert.equal(
		utils.whatsapp.isForwarded({
			extendedTextMessage: { contextInfo: { isForwarded: true } },
		}),
		true,
	);
	assert.equal(utils.whatsapp.isForwarded({ conversation: "plain" }), false);
});
