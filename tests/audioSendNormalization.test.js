import assert from "node:assert/strict";
import test from "node:test";

import { createAudioSendContentNormalizer } from "../src/internal/audioSendNormalization.js";

test("audio normalizer leaves non-audio content unchanged", async () => {
	const normalizeAudioSendContentForWhatsApp = createAudioSendContentNormalizer();
	const content = {
		image: { url: "https://cdn.discordapp.com/attachments/test.png" },
		mimetype: "image/png",
	};
	const normalized = await normalizeAudioSendContentForWhatsApp({
		attachment: { url: "https://cdn.discordapp.com/attachments/test.png" },
		content,
	});
	assert.equal(normalized, content);
});

test("audio normalizer marks voice-like attachments and hydrates audio buffer", async () => {
	const normalizeAudioSendContentForWhatsApp = createAudioSendContentNormalizer({
		getLogger: () => ({ warn() {}, debug() {} }),
		normalizeBridgeMessageId: (value) => value,
		toBuffer: (value) => {
			if (Buffer.isBuffer(value)) return value;
			if (value instanceof Uint8Array) return Buffer.from(value);
			return null;
		},
	});
	const payload = Buffer.from("tiny-audio", "utf8");
	const waveform = Buffer.from([1, 4, 2, 0, 5]);
	const normalized = await normalizeAudioSendContentForWhatsApp({
		attachment: {
			url: `data:audio/mpeg;base64,${payload.toString("base64")}`,
			name: "voice-note.m4a",
			contentType: "audio/mpeg",
			duration: 2.4,
			waveform,
		},
		content: {
			audio: { url: "https://cdn.discordapp.com/attachments/audio.m4a" },
			mimetype: "audio/mpeg",
		},
		jid: "123@s.whatsapp.net",
		discordMessageId: "dc-1",
	});
	assert.equal(normalized.ptt, true);
	assert.equal(normalized.seconds, 2);
	assert.deepEqual(normalized.waveform, waveform);
	assert.ok(Buffer.isBuffer(normalized.audio));
	assert.ok(normalized.audio.length > 0);
});
