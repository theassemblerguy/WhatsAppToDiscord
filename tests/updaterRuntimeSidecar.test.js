import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";

import state from "../src/state.js";
import utils from "../src/utils.js";

test("packaged updater installs the matching runtime sidecar archive", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-updater-runtime-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const runtimePath = path.join(tempDir, "runtime");
	const stagedRuntimeRoot = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-staged-"),
	);
	const archivePath = path.join(
		stagedRuntimeRoot,
		"WA2DC-Linux.runtime.tar.gz",
	);

	const originalUpdater = {
		isNode: utils.updater.isNode,
		getCurrentExecutablePath: utils.updater.getCurrentExecutablePath,
		downloadLatestVersion: utils.updater.downloadLatestVersion,
		downloadSignature: utils.updater.downloadSignature,
		downloadRuntimeArchive: utils.updater.downloadRuntimeArchive,
		downloadRuntimeArchiveSignature:
			utils.updater.downloadRuntimeArchiveSignature,
		validateSignature: utils.updater.validateSignature,
	};
	const defaultExeNameDescriptor = Object.getOwnPropertyDescriptor(
		utils.updater,
		"defaultExeName",
	);
	const originalKeepOldBinary = state.settings.KeepOldBinary;

	try {
		await fsPromises.writeFile(currentExePath, "old-binary");
		await fsPromises.mkdir(path.join(runtimePath, "node_modules", "sharp"), {
			recursive: true,
		});
		await fsPromises.writeFile(
			path.join(runtimePath, "package.json"),
			'{"private":true,"description":"old runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(runtimePath, "node_modules", "sharp", "package.json"),
			'{"name":"sharp","version":"0.34.4"}\n',
		);

		await fsPromises.mkdir(
			path.join(stagedRuntimeRoot, "runtime", "node_modules", "sharp"),
			{ recursive: true },
		);
		await fsPromises.writeFile(
			path.join(stagedRuntimeRoot, "runtime", "package.json"),
			'{"private":true,"description":"new runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"package.json",
			),
			'{"name":"sharp","version":"0.34.5"}\n',
		);
		await tar.create(
			{
				cwd: stagedRuntimeRoot,
				file: archivePath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);

		utils.updater.isNode = false;
		utils.updater.getCurrentExecutablePath = () => currentExePath;
		Object.defineProperty(utils.updater, "defaultExeName", {
			configurable: true,
			get: () => "WA2DC-Linux",
		});
		utils.updater.downloadLatestVersion = async (
			_defaultExeName,
			targetPath,
		) => {
			await fsPromises.writeFile(targetPath, "new-binary");
			return true;
		};
		utils.updater.downloadSignature = async () => ({
			result: Buffer.from("sig"),
		});
		utils.updater.downloadRuntimeArchive = async (
			_defaultExeName,
			targetPath,
		) => {
			await fsPromises.copyFile(archivePath, targetPath);
			return true;
		};
		utils.updater.downloadRuntimeArchiveSignature = async () => ({
			result: Buffer.from("sig"),
		});
		utils.updater.validateSignature = () => true;
		state.settings.KeepOldBinary = true;

		const result = await utils.updater.update("v9.9.9");
		assert.equal(result, true);
		assert.equal(
			await fsPromises.readFile(currentExePath, "utf8"),
			"new-binary",
		);
		assert.match(
			await fsPromises.readFile(path.join(runtimePath, "package.json"), "utf8"),
			/new runtime/u,
		);
		assert.match(
			await fsPromises.readFile(
				path.join(runtimePath, "node_modules", "sharp", "package.json"),
				"utf8",
			),
			/0\.34\.5/u,
		);
		await assert.rejects(
			() =>
				fsPromises.stat(path.join(os.tmpdir(), "WA2DC-Linux.runtime.tar.gz")),
			/ENOENT/,
		);
	} finally {
		utils.updater.isNode = originalUpdater.isNode;
		utils.updater.getCurrentExecutablePath =
			originalUpdater.getCurrentExecutablePath;
		utils.updater.downloadLatestVersion = originalUpdater.downloadLatestVersion;
		utils.updater.downloadSignature = originalUpdater.downloadSignature;
		utils.updater.downloadRuntimeArchive =
			originalUpdater.downloadRuntimeArchive;
		utils.updater.downloadRuntimeArchiveSignature =
			originalUpdater.downloadRuntimeArchiveSignature;
		utils.updater.validateSignature = originalUpdater.validateSignature;
		if (defaultExeNameDescriptor) {
			Object.defineProperty(
				utils.updater,
				"defaultExeName",
				defaultExeNameDescriptor,
			);
		}
		state.settings.KeepOldBinary = originalKeepOldBinary;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
		await fsPromises.rm(stagedRuntimeRoot, { recursive: true, force: true });
	}
});

test("packaged startup bootstraps runtime sidecar when missing", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-bootstrap-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const runtimePath = path.join(tempDir, "runtime");
	const stagedRuntimeRoot = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-bootstrap-staged-"),
	);
	const archivePath = path.join(
		stagedRuntimeRoot,
		"WA2DC-Linux.runtime.tar.gz",
	);

	const originalProcessPkgDescriptor = Object.getOwnPropertyDescriptor(
		process,
		"pkg",
	);
	const originalUpdater = {
		downloadRuntimeArchive: utils.updater.downloadRuntimeArchive,
		downloadRuntimeArchiveSignature:
			utils.updater.downloadRuntimeArchiveSignature,
		validateSignature: utils.updater.validateSignature,
		getCurrentExecutablePath: utils.updater.getCurrentExecutablePath,
	};
	const defaultExeNameDescriptor = Object.getOwnPropertyDescriptor(
		utils.updater,
		"defaultExeName",
	);
	const originalLogger = state.logger;
	const originalKeepOldBinary = state.settings.KeepOldBinary;

	try {
		await fsPromises.writeFile(currentExePath, "binary");
		await fsPromises.mkdir(
			path.join(stagedRuntimeRoot, "runtime", "node_modules", "sharp"),
			{ recursive: true },
		);
		await fsPromises.writeFile(
			path.join(stagedRuntimeRoot, "runtime", "package.json"),
			'{"private":true,"description":"bootstrapped runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"index.js",
			),
			"module.exports = function sharp() {}; module.exports.default = module.exports;\n",
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"package.json",
			),
			'{"name":"sharp","main":"index.js","version":"0.34.5"}\n',
		);
		await tar.create(
			{
				cwd: stagedRuntimeRoot,
				file: archivePath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);

		Object.defineProperty(process, "pkg", {
			configurable: true,
			value: {},
		});
		utils.updater.getCurrentExecutablePath = () => currentExePath;
		Object.defineProperty(utils.updater, "defaultExeName", {
			configurable: true,
			get: () => "WA2DC-Linux",
		});
		utils.updater.downloadRuntimeArchive = async (
			_defaultExeName,
			targetPath,
		) => {
			await fsPromises.copyFile(archivePath, targetPath);
			return true;
		};
		utils.updater.downloadRuntimeArchiveSignature = async () => ({
			result: Buffer.from("sig"),
		});
		utils.updater.validateSignature = () => true;
		state.logger = { info() {}, warn() {}, error() {} };
		state.settings.KeepOldBinary = false;

		const result = await utils.updater.ensureRuntimeSidecar("v9.9.9");
		assert.equal(result, true);
		assert.match(
			await fsPromises.readFile(path.join(runtimePath, "package.json"), "utf8"),
			/bootstrapped runtime/u,
		);
		await assert.rejects(
			() => fsPromises.stat(`${runtimePath}.oldVersion`),
			/ENOENT/,
		);
	} finally {
		if (originalProcessPkgDescriptor) {
			Object.defineProperty(process, "pkg", originalProcessPkgDescriptor);
		} else {
			delete process.pkg;
		}
		utils.updater.downloadRuntimeArchive =
			originalUpdater.downloadRuntimeArchive;
		utils.updater.downloadRuntimeArchiveSignature =
			originalUpdater.downloadRuntimeArchiveSignature;
		utils.updater.validateSignature = originalUpdater.validateSignature;
		utils.updater.getCurrentExecutablePath =
			originalUpdater.getCurrentExecutablePath;
		if (defaultExeNameDescriptor) {
			Object.defineProperty(
				utils.updater,
				"defaultExeName",
				defaultExeNameDescriptor,
			);
		}
		state.logger = originalLogger;
		state.settings.KeepOldBinary = originalKeepOldBinary;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
		await fsPromises.rm(stagedRuntimeRoot, { recursive: true, force: true });
	}
});

test("runtime archive install falls back to copy when rename crosses filesystems", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-exdev-"),
	);
	const currentExePath = path.join(tempDir, "WA2DC-Linux");
	const runtimePath = path.join(tempDir, "runtime");
	const stagedRuntimeRoot = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-runtime-exdev-staged-"),
	);
	const archivePath = path.join(stagedRuntimeRoot, "WA2DC-Linux.runtime.tar.gz");

	const originalGetCurrentExecutablePath = utils.updater.getCurrentExecutablePath;
	const originalRename = fs.promises.rename;
	const originalCp = fs.promises.cp;
	let renameFailed = false;
	let copyCalled = false;

	try {
		await fsPromises.writeFile(currentExePath, "binary");
		await fsPromises.mkdir(
			path.join(stagedRuntimeRoot, "runtime", "node_modules", "sharp"),
			{ recursive: true },
		);
		await fsPromises.writeFile(
			path.join(stagedRuntimeRoot, "runtime", "package.json"),
			'{"private":true,"description":"exdev runtime"}\n',
		);
		await fsPromises.writeFile(
			path.join(
				stagedRuntimeRoot,
				"runtime",
				"node_modules",
				"sharp",
				"package.json",
			),
			'{"name":"sharp","version":"0.34.5"}\n',
		);
		await tar.create(
			{
				cwd: stagedRuntimeRoot,
				file: archivePath,
				gzip: true,
				portable: true,
			},
			["runtime"],
		);

		utils.updater.getCurrentExecutablePath = () => currentExePath;
		fs.promises.rename = async (from, to) => {
			if (
				String(from).includes("wa2dc-runtime-install-") &&
				to === runtimePath
			) {
				renameFailed = true;
				const err = new Error("cross-device");
				err.code = "EXDEV";
				throw err;
			}
			return originalRename.call(fs.promises, from, to);
		};
		fs.promises.cp = async (...args) => {
			copyCalled = true;
			return originalCp.call(fs.promises, ...args);
		};

		await utils.updater.installRuntimeArchive(archivePath);
		assert.equal(renameFailed, true);
		assert.equal(copyCalled, true);
		assert.match(
			await fsPromises.readFile(path.join(runtimePath, "package.json"), "utf8"),
			/exdev runtime/u,
		);
	} finally {
		utils.updater.getCurrentExecutablePath = originalGetCurrentExecutablePath;
		fs.promises.rename = originalRename;
		fs.promises.cp = originalCp;
		await fsPromises.rm(tempDir, { recursive: true, force: true });
		await fsPromises.rm(stagedRuntimeRoot, { recursive: true, force: true });
	}
});
