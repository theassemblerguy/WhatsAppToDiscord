import crypto from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import {
	aesEncryptGCM,
	hmacSign,
} from "@whiskeysockets/baileys/lib/Utils/crypto.js";
import { getKeyAuthor } from "@whiskeysockets/baileys/lib/Utils/generics.js";

const ZERO_32 = new Uint8Array(32);

const hashOption = (name = "") =>
	crypto
		.createHash("sha256")
		.update(name || "")
		.digest();

const getPollFromMessage = (msg = {}) =>
	msg.pollCreationMessage ||
	msg.pollCreationMessageV2 ||
	msg.pollCreationMessageV3 ||
	msg.pollCreationMessageV4;

const getPollOptions = (poll) =>
	Array.isArray(poll?.options)
		? poll.options.map((opt) => opt?.optionName || "Option")
		: [];

const getPollEncKey = (pollMessage = {}) => {
	const poll = getPollFromMessage(pollMessage.message || pollMessage);
	const contexts = [
		poll?.contextInfo?.messageSecret,
		pollMessage.message?.contextInfo?.messageSecret,
		pollMessage.message?.messageContextInfo?.messageSecret,
		pollMessage.messageContextInfo?.messageSecret,
		poll?.encKey,
	];
	return contexts.find(Boolean) || null;
};

const buildPollVotePayload = ({
	pollMessage,
	optionIndexes = [],
	voterJid,
}) => {
	if (!pollMessage?.key?.id || !pollMessage.message) {
		throw new Error("Invalid poll message");
	}
	const poll = getPollFromMessage(pollMessage.message);
	if (!poll) {
		throw new Error("Poll creation data missing");
	}
	const pollEncKey = getPollEncKey(pollMessage);
	if (!pollEncKey) {
		throw new Error("Poll encryption key missing");
	}
	const pollMsgId = pollMessage.key.id;
	const pollCreatorJid = getKeyAuthor(pollMessage.key, voterJid);
	const selected = Array.from(new Set(optionIndexes))
		.map((idx) => poll.options?.[idx]?.optionName || null)
		.filter(Boolean)
		.map((name) => hashOption(name));
	if (!selected.length) {
		throw new Error("No valid poll options selected");
	}
	const voteMsg = proto.Message.PollVoteMessage.create({
		selectedOptions: selected,
	});
	const voteBytes = proto.Message.PollVoteMessage.encode(voteMsg).finish();
	const iv = crypto.randomBytes(12);
	const sign = Buffer.concat([
		Buffer.from(pollMsgId),
		Buffer.from(pollCreatorJid),
		Buffer.from(voterJid),
		Buffer.from("Poll Vote"),
		Buffer.from([1]),
	]);
	const key0 = hmacSign(pollEncKey, ZERO_32, "sha256");
	const encKey = hmacSign(sign, key0, "sha256");
	const aad = Buffer.from(`${pollMsgId}\u0000${voterJid}`);
	const encPayload = aesEncryptGCM(voteBytes, encKey, iv, aad);
	return {
		pollUpdateMessage: {
			pollCreationMessageKey: pollMessage.key,
			vote: {
				encPayload,
				encIv: iv,
			},
			senderTimestampMs: Date.now(),
		},
	};
};

export {
	buildPollVotePayload,
	getPollEncKey,
	getPollFromMessage,
	getPollOptions,
};
