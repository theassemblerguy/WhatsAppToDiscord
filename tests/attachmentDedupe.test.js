import assert from "node:assert/strict";
import test from "node:test";
import { StickerFormatType } from "discord.js";

import utils from "../src/utils.js";

test("Discord attachment/embed image URLs dedupe via proxy normalization", () => {
	const cdnUrl =
		"https://cdn.discordapp.com/attachments/123/456/image.png?ex=abc&is=def&hm=ghi";
	const proxyUrl =
		"https://images-ext-1.discordapp.net/external/token/https/cdn.discordapp.com/attachments/123/456/image.png?format=webp&width=400&height=300";

	assert.equal(
		utils.discord.normalizeAttachmentUrl(cdnUrl),
		utils.discord.normalizeAttachmentUrl(proxyUrl),
	);

	const deduped = utils.discord.dedupeCollectedAttachments([
		{ url: cdnUrl, name: "image.png", contentType: "image/png" },
		{ url: proxyUrl, name: "image.webp", contentType: "image/webp" },
	]);
	assert.equal(deduped.length, 1);
});

test("Discord mergeCollectedAttachments dedupes across attachment groups", () => {
	const base = [
		{
			url: "https://cdn.discordapp.com/attachments/1/2/file.png?ex=a",
			name: "file.png",
			contentType: "image/png",
		},
	];
	const extra = [
		{
			url: "https://images-ext-1.discordapp.net/external/token/https/cdn.discordapp.com/attachments/1/2/file.png?format=webp",
			name: "file.webp",
			contentType: "image/webp",
		},
		{
			url: "https://cdn.discordapp.com/attachments/1/2/other.png?ex=b",
			name: "other.png",
			contentType: "image/png",
		},
	];
	const merged = utils.discord.mergeCollectedAttachments(base, extra);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].name, "file.png");
	assert.equal(merged[1].name, "other.png");
});

test("Discord GIF upload previews prefer a single animated video candidate", () => {
	const attachmentUrl =
		"https://cdn.discordapp.com/attachments/123/456/funny-cat.gif?ex=abc&is=def";
	const previewUrl =
		"https://media.discordapp.net/attachments/123/456/funny-cat.mp4?width=320&height=240";

	const collected = utils.discord.collectMessageMedia({
		attachments: new Map([
			[
				"attachment-1",
				{
					id: "attachment-1",
					url: attachmentUrl,
					name: "funny-cat.gif",
					contentType: "image/gif",
				},
			],
		]),
		stickers: new Map(),
		embeds: [
			{
				title: "Funny Cat",
				video: {
					url: previewUrl,
				},
			},
		],
	});

	assert.equal(collected.attachments.length, 1);
	assert.equal(collected.attachments[0]?.url, previewUrl);
	assert.equal(collected.attachments[0]?.contentType, "video/mp4");
	assert.equal(collected.attachments[0]?.gifPlayback, true);
});

test("Discord provider GIF embeds infer mp4 media when the video URL has no extension", () => {
	const collected = utils.discord.collectMessageMedia({
		content: "https://tenor.com/view/ouch-gif-12136515515962044163",
		attachments: new Map(),
		stickers: new Map(),
		embeds: [
			{
				title: "Ouch",
				url: "https://tenor.com/view/ouch-gif-12136515515962044163",
				provider: { name: "Tenor" },
				video: {
					url: "https://media.tenor.com/abc123/tenor",
				},
			},
		],
	});

	assert.equal(collected.attachments.length, 1);
	assert.equal(
		collected.attachments[0]?.url,
		"https://media.tenor.com/abc123/tenor",
	);
	assert.equal(collected.attachments[0]?.contentType, "video/mp4");
	assert.equal(collected.attachments[0]?.gifPlayback, true);
	assert.deepEqual(collected.consumedUrls, [
		"https://tenor.com/view/ouch-gif-12136515515962044163",
	]);
});

test("Discord GIF embeds do not add a duplicate preview image when embed mirroring is enabled", () => {
	const collected = utils.discord.collectMessageMedia(
		{
			attachments: new Map(),
			stickers: new Map(),
			embeds: [
				{
					title: "Funny Cat",
					url: "https://tenor.com/view/funny-cat-1",
					provider: { name: "Tenor" },
					video: {
						url: "https://media.tenor.com/funny-cat",
					},
					thumbnail: {
						url: "https://media.tenor.com/funny-cat-preview.png",
					},
				},
			],
		},
		{ includeEmbedAttachments: true },
	);

	assert.equal(collected.attachments.length, 1);
	assert.equal(
		collected.attachments[0]?.url,
		"https://media.tenor.com/funny-cat",
	);
	assert.equal(collected.attachments[0]?.contentType, "video/mp4");
	assert.equal(collected.attachments[0]?.gifPlayback, true);
});

test("WhatsApp document content preserves gifPlayback for collected GIF videos", () => {
	const content = utils.whatsapp.createDocumentContent({
		url: "https://media.discordapp.net/attachments/123/456/funny-cat.mp4",
		name: "funny-cat.mp4",
		contentType: "video/mp4",
		gifPlayback: true,
	});

	assert.deepEqual(content.video, {
		url: "https://media.discordapp.net/attachments/123/456/funny-cat.mp4",
	});
	assert.equal(content.mimetype, "video/mp4");
	assert.equal(content.gifPlayback, true);
});

test("Discord sticker attachments prefer the provided sticker asset URL", () => {
	const collected = utils.discord.collectStickerAttachments({
		stickers: new Map([
			[
				"sticker-1",
				{
					id: "796140687639838730",
					name: "animated-sticker",
					format: StickerFormatType.GIF,
					url: "https://cdn.discordapp.com/stickers/796140687639838730.gif",
				},
			],
		]),
	});

	assert.equal(collected.length, 1);
	assert.equal(
		collected[0]?.url,
		"https://cdn.discordapp.com/stickers/796140687639838730.gif",
	);
	assert.equal(collected[0]?.name, "animated-sticker-796140687639838730.gif");
	assert.equal(collected[0]?.contentType, "image/gif");
});
