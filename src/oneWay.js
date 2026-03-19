const ONE_WAY_DIRECTIONS = Object.freeze({
	WHATSAPP_TO_DISCORD: 0b01,
	DISCORD_TO_WHATSAPP: 0b10,
});

const ONE_WAY_MODES = Object.freeze({
	TO_DISCORD_ONLY: ONE_WAY_DIRECTIONS.WHATSAPP_TO_DISCORD,
	TO_WHATSAPP_ONLY: ONE_WAY_DIRECTIONS.DISCORD_TO_WHATSAPP,
	TWO_WAY:
		ONE_WAY_DIRECTIONS.WHATSAPP_TO_DISCORD |
		ONE_WAY_DIRECTIONS.DISCORD_TO_WHATSAPP,
});

const normalizeOneWayValue = (oneWayValue) => {
	const numeric = Number(oneWayValue);
	return Number.isFinite(numeric) ? numeric | 0 : 0;
};

const hasOneWayDirection = (oneWayValue, directionMask) =>
	(normalizeOneWayValue(oneWayValue) & directionMask) !== 0;

const oneWayAllowsWhatsAppToDiscord = (oneWayValue) =>
	hasOneWayDirection(oneWayValue, ONE_WAY_DIRECTIONS.WHATSAPP_TO_DISCORD);

const oneWayAllowsDiscordToWhatsApp = (oneWayValue) =>
	hasOneWayDirection(oneWayValue, ONE_WAY_DIRECTIONS.DISCORD_TO_WHATSAPP);

export {
	hasOneWayDirection,
	ONE_WAY_DIRECTIONS,
	ONE_WAY_MODES,
	oneWayAllowsDiscordToWhatsApp,
	oneWayAllowsWhatsAppToDiscord,
};
