import assert from "node:assert/strict";
import test from "node:test";

import { getImageSharp } from "../src/imageLibs.js";
import { createStickerSendContentNormalizer } from "../src/internal/stickerSendNormalization.js";

test("Lottie Discord stickers can be converted to animated WhatsApp stickers", async (t) => {
	const sharp = await getImageSharp();
	if (!sharp) {
		t.skip("sharp is not available");
		return;
	}

	const normalizeStickerSendContentForWhatsApp =
		createStickerSendContentNormalizer({
			getLogger: () => ({ warn() {}, debug() {} }),
			normalizeBridgeMessageId: (value) => value,
			getImageSharp,
		});

	const animationData = {
		v: "5.7.4",
		fr: 10,
		ip: 0,
		op: 10,
		w: 32,
		h: 32,
		nm: "wa2dc-test-sticker",
		ddd: 0,
		assets: [],
		layers: [
			{
				ddd: 0,
				ind: 1,
				ty: 4,
				nm: "shape",
				sr: 1,
				ks: {
					o: { a: 0, k: 100 },
					r: { a: 0, k: 0 },
					p: {
						a: 1,
						k: [
							{
								t: 0,
								s: [8, 16, 0],
								e: [24, 16, 0],
								i: { x: [0.667, 0.667, 0.667], y: [1, 1, 1] },
								o: { x: [0.333, 0.333, 0.333], y: [0, 0, 0] },
							},
							{ t: 10, s: [24, 16, 0] },
						],
					},
					a: { a: 0, k: [0, 0, 0] },
					s: { a: 0, k: [100, 100, 100] },
				},
				shapes: [
					{
						ty: "gr",
						it: [
							{
								ty: "rc",
								p: { a: 0, k: [0, 0] },
								s: { a: 0, k: [12, 12] },
								r: { a: 0, k: 4 },
								nm: "rect",
							},
							{
								ty: "fl",
								c: { a: 0, k: [1, 0.25, 0, 1] },
								o: { a: 0, k: 100 },
								r: 1,
								nm: "fill",
							},
							{
								ty: "tr",
								p: { a: 0, k: [0, 0] },
								a: { a: 0, k: [0, 0] },
								s: { a: 0, k: [100, 100] },
								r: { a: 0, k: 0 },
								o: { a: 0, k: 100 },
								sk: { a: 0, k: 0 },
								sa: { a: 0, k: 0 },
								nm: "transform",
							},
						],
						nm: "group",
					},
				],
				ao: 0,
				ip: 0,
				op: 10,
				st: 0,
				bm: 0,
			},
		],
	};
	const lottieBuffer = Buffer.from(JSON.stringify(animationData), "utf8");
	const normalized = await normalizeStickerSendContentForWhatsApp({
		attachment: {
			isSticker: true,
			discordStickerFormat: 3,
			contentType: "application/json; charset=utf-8",
			url: `data:application/json;base64,${lottieBuffer.toString("base64")}`,
			name: "moving-square.json",
		},
		jid: "120363123456789@s.whatsapp.net",
		discordMessageId: "dc-lottie-sticker",
	});

	assert.ok(normalized);
	assert.ok(Buffer.isBuffer(normalized.sticker));
	assert.equal(normalized.mimetype, "image/webp");
	assert.equal(normalized.isAnimated, true);
	assert.equal(normalized.width, 512);
	assert.equal(normalized.height, 512);

	const metadata = await sharp(normalized.sticker, {
		animated: true,
	}).metadata();
	assert.ok((Number(metadata.pages) || 1) > 1);
});
