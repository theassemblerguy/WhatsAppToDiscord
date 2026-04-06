import assert from "node:assert/strict";
import test from "node:test";

import utils from "../src/utils.js";

test("Discord bare domains gain an explicit https scheme", () => {
	const result = utils.discord.ensureExplicitUrlScheme("Check example.com");

	assert.equal(result.matched, "example.com");
	assert.equal(result.normalized, "https://example.com/");
	assert.equal(result.text, "Check https://example.com/");
});

test("Discord email addresses are not rewritten as URLs", () => {
	const email = "fokionos.airbnb@gmail.com";
	const result = utils.discord.ensureExplicitUrlScheme(email);

	assert.equal(result.matched, null);
	assert.equal(result.normalized, null);
	assert.equal(result.text, email);
});
