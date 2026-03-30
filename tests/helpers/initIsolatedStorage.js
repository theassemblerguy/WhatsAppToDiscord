import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

import storage from "../../src/storage.js";

const initIsolatedStorage = async (fileUrl) => {
	const originalDir = storage._storageDir;
	const fileName = path.parse(fileURLToPath(fileUrl)).name;
	const tempBase = await fs.mkdtemp(
		path.join(os.tmpdir(), `wa2dc-${fileName}-`),
	);
	const sandboxDir = path.join(tempBase, "storage");

	storage._storageDir = sandboxDir;
	await storage.close();

	after(async () => {
		await storage.close();
		storage._storageDir = originalDir;
		await fs.rm(tempBase, { recursive: true, force: true });
	});

	await storage.ensureInitialized();
	return { tempBase, sandboxDir };
};

export default initIsolatedStorage;
