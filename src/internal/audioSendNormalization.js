import childProcess from "node:child_process";

const DISCORD_AUDIO_FETCH_MAX_BYTES = 25 * 1024 * 1024;
const DISCORD_AUDIO_TRANSCODE_TIMEOUT_MS = 20 * 1000;
const DISCORD_VOICE_NAME_HINT_REGEX = /(voice|ptt|push-?to-?talk)/i;

const normalizeMimeType = (value = "") => {
	if (typeof value !== "string") return "";
	return value.split(";")[0].trim().toLowerCase();
};

const decodeDataUrlBuffer = (sourceUrl = "") => {
	const commaIndex = sourceUrl.indexOf(",");
	if (commaIndex < 0) {
		return null;
	}
	const meta = sourceUrl.slice(0, commaIndex);
	const payload = sourceUrl.slice(commaIndex + 1);
	if (!payload) {
		return null;
	}
	const isBase64 = /;base64$/i.test(meta);
	return isBase64
		? Buffer.from(payload, "base64")
		: Buffer.from(decodeURIComponent(payload), "utf8");
};

const loadAttachmentBufferForWhatsApp = async (attachment = {}) => {
	const sourceUrl =
		typeof attachment?.url === "string" ? attachment.url.trim() : "";
	if (!sourceUrl) return null;
	if (sourceUrl.startsWith("data:")) {
		const decoded = decodeDataUrlBuffer(sourceUrl);
		if (!decoded?.length) return null;
		if (decoded.length > DISCORD_AUDIO_FETCH_MAX_BYTES) {
			throw new Error(`buffer_length_exceeded:${decoded.length}`);
		}
		return decoded;
	}
	if (!/^https?:\/\//i.test(sourceUrl)) {
		return null;
	}
	const response = await fetch(sourceUrl);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	const contentLength = Number.parseInt(
		response.headers.get("content-length") || "",
		10,
	);
	if (
		Number.isFinite(contentLength) &&
		contentLength > DISCORD_AUDIO_FETCH_MAX_BYTES
	) {
		throw new Error(`content_length_exceeded:${contentLength}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > DISCORD_AUDIO_FETCH_MAX_BYTES) {
		throw new Error(`buffer_length_exceeded:${buffer.length}`);
	}
	return buffer;
};

const isDiscordVoiceLikeAttachment = (attachment = {}, mimetype = "") => {
	const normalizedMime = normalizeMimeType(mimetype || attachment?.contentType);
	const name = typeof attachment?.name === "string" ? attachment.name : "";
	const durationCandidates = [
		attachment?.duration,
		attachment?.duration_secs,
		attachment?.durationSeconds,
	];
	const hasDuration = durationCandidates.some((entry) => {
		const value = Number(entry);
		return Number.isFinite(value) && value > 0;
	});
	return (
		hasDuration ||
		DISCORD_VOICE_NAME_HINT_REGEX.test(name) ||
		normalizedMime === "audio/ogg" ||
		normalizedMime === "audio/opus"
	);
};

const transcodeAudioBufferToOggOpus = async (inputBuffer) => {
	if (!inputBuffer?.length) return null;
	return await new Promise((resolve, reject) => {
		const ffmpeg = childProcess.spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				"pipe:0",
				"-vn",
				"-ac",
				"1",
				"-c:a",
				"libopus",
				"-ar",
				"48000",
				"-avoid_negative_ts",
				"make_zero",
				"-f",
				"ogg",
				"pipe:1",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);

		const stdoutChunks = [];
		const stderrChunks = [];
		let completed = false;
		const finish = (err, output = null) => {
			if (completed) return;
			completed = true;
			clearTimeout(timeout);
			if (err) {
				reject(err);
				return;
			}
			resolve(output);
		};
		const timeout = setTimeout(() => {
			ffmpeg.kill("SIGKILL");
			finish(new Error("ffmpeg_timeout"));
		}, DISCORD_AUDIO_TRANSCODE_TIMEOUT_MS);

		ffmpeg.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
		ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));
		ffmpeg.on("error", (err) => finish(err));
		ffmpeg.on("close", (code) => {
			if (code !== 0) {
				const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
				finish(
					new Error(`ffmpeg_exit_${code}${stderrText ? `:${stderrText}` : ""}`),
				);
				return;
			}
			const output = Buffer.concat(stdoutChunks);
			if (!output.length) {
				finish(new Error("ffmpeg_empty_output"));
				return;
			}
			finish(null, output);
		});

		ffmpeg.stdin.on("error", () => {});
		ffmpeg.stdin.end(inputBuffer);
	});
};

export const createAudioSendContentNormalizer = ({
	getLogger = null,
	normalizeBridgeMessageId = (value) => value,
} = {}) => {
	let ffmpegMissingLogged = false;
	const loggerForCall = () =>
		typeof getLogger === "function" ? getLogger() : getLogger;

	return async ({ attachment, content, jid, discordMessageId } = {}) => {
		if (!content || typeof content !== "object" || !content.audio) {
			return content;
		}
		const normalizedMime = normalizeMimeType(
			content?.mimetype || attachment?.contentType,
		);
		if (!normalizedMime.startsWith("audio/")) {
			return content;
		}

		const logger = loggerForCall();
		const normalizedContent = { ...content };
		const isVoiceLike = isDiscordVoiceLikeAttachment(
			attachment,
			normalizedMime,
		);
		if (isVoiceLike) {
			normalizedContent.ptt = true;
			const duration =
				Number(attachment?.duration) ||
				Number(attachment?.duration_secs) ||
				Number(attachment?.durationSeconds) ||
				0;
			if (Number.isFinite(duration) && duration > 0) {
				normalizedContent.seconds = Math.max(1, Math.round(duration));
			}
		}

		let sourceBuffer = null;
		try {
			sourceBuffer = await loadAttachmentBufferForWhatsApp(attachment);
		} catch (err) {
			logger?.debug?.(
				{
					err,
					jid,
					discordMessageId: normalizeBridgeMessageId(discordMessageId),
					attachmentName: attachment?.name || null,
					mimetype: normalizedMime,
				},
				"Failed to fetch Discord audio attachment before WhatsApp send",
			);
		}
		if (!sourceBuffer?.length) {
			return normalizedContent;
		}

		normalizedContent.audio = sourceBuffer;
		if (!isVoiceLike) {
			return normalizedContent;
		}

		try {
			const transcoded = await transcodeAudioBufferToOggOpus(sourceBuffer);
			if (transcoded?.length) {
				normalizedContent.audio = transcoded;
				normalizedContent.mimetype = "audio/ogg; codecs=opus";
			}
		} catch (err) {
			if (err?.code === "ENOENT") {
				if (!ffmpegMissingLogged) {
					ffmpegMissingLogged = true;
					logger?.warn?.(
						"ffmpeg is not installed; sending Discord voice messages without opus transcode",
					);
				}
			} else {
				logger?.debug?.(
					{
						err,
						jid,
						discordMessageId: normalizeBridgeMessageId(discordMessageId),
						attachmentName: attachment?.name || null,
					},
					"Failed to transcode Discord voice message to WhatsApp-compatible opus",
				);
			}
		}

		return normalizedContent;
	};
};
