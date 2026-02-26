import assert from "node:assert/strict";
import test from "node:test";

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
