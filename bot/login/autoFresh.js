"use strict";

const fs = require("fs-extra");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

async function autoFreshCleanup() {
	const targets = [
		path.join(ROOT, "scripts", "cmds", "cache"),
		path.join(ROOT, "scripts", "cmds", "tmp"),
		path.join(ROOT, "tmp"),
		path.join(ROOT, "cache"),
		path.join(ROOT, "temp")
	];

	for (const dir of targets) {
		try {
			if (!await fs.pathExists(dir)) continue;
			const entries = await fs.readdir(dir);
			for (const entry of entries) {
				await fs.remove(path.join(dir, entry)).catch(() => {});
			}
		}
		catch (e) {}
	}

	try {
		const dataDir = path.join(ROOT, "data");
		if (await fs.pathExists(dataDir)) {
			const entries = await fs.readdir(dataDir);
			for (const entry of entries) {
				if (!entry.endsWith(".tmp")) continue;
				await fs.remove(path.join(dataDir, entry)).catch(() => {});
			}
		}
	}
	catch (e) {}
}

module.exports = autoFreshCleanup;
