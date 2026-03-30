import { createRequire } from "node:module";
import path from "node:path";

let imageSharpPromise = null;
let packagedSharpRequire = null;
let imageLibTestOverrides = null;

export const resetImageLibTestOverrides = () => {
	imageLibTestOverrides = null;
};

export const setImageLibTestOverrides = (overrides = null) => {
	imageLibTestOverrides =
		overrides && typeof overrides === "object" ? overrides : null;
};

const getPackagedSharpRequire = () => {
	if (!process.pkg) {
		return null;
	}
	if (!packagedSharpRequire) {
		const runtimePackagePath = path.join(
			path.dirname(process.execPath),
			"runtime",
			"package.json",
		);
		packagedSharpRequire = createRequire(runtimePackagePath);
	}
	return packagedSharpRequire;
};

export const getImageSharp = async () => {
	if (typeof imageLibTestOverrides?.getImageSharp === "function") {
		return imageLibTestOverrides.getImageSharp();
	}
	if (!imageSharpPromise) {
		imageSharpPromise = (async () => {
			if (process.pkg) {
				try {
					const sharpFromSidecar = getPackagedSharpRequire()?.("sharp");
					const sharp = sharpFromSidecar?.default || sharpFromSidecar || null;
					if (typeof sharp === "function") {
						return sharp;
					}
				} catch {
					return null;
				}
				return null;
			}
			try {
				const mod = await import("sharp");
				const sharp = mod?.default || mod;
				return typeof sharp === "function" ? sharp : null;
			} catch {
				return null;
			}
		})();
	}
	return imageSharpPromise;
};
