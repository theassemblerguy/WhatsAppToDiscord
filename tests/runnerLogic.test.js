import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	clearRestartFlagSync,
	computeBackoffDelayMs,
	consumeRestartFlagSync,
	evaluateUpdateValidationExit,
	evaluateWorkerExit,
	findRollbackBackupPathSync,
	parseRestartFlagPayload,
	resolveRollbackBackupCandidates,
	revertExecutableToBackupSync,
	revertPackagedArtifactsToBackupSync,
} from "../src/runnerLogic.js";

test("computeBackoffDelayMs doubles per attempt", () => {
	assert.equal(computeBackoffDelayMs(10, 1), 10);
	assert.equal(computeBackoffDelayMs(10, 2), 20);
	assert.equal(computeBackoffDelayMs(10, 3), 40);
});

test("evaluateWorkerExit exits cleanly on code 0", () => {
	const result = evaluateWorkerExit({
		exitCode: 0,
		restartRequested: false,
		restartAttempts: 3,
	});

	assert.deepEqual(result, {
		action: "exit",
		reason: "clean-exit",
		exitCode: 0,
		restartAttempts: 3,
		delayMs: null,
	});
});

test("evaluateWorkerExit restarts immediately when restart.flag is present (even on code 0)", () => {
	const result = evaluateWorkerExit({
		exitCode: 0,
		restartRequested: true,
		restartAttempts: 4,
	});

	assert.deepEqual(result, {
		action: "restart",
		reason: "restart-flag",
		exitCode: null,
		restartAttempts: 0,
		delayMs: 0,
	});
});

test("evaluateWorkerExit applies exponential backoff for crashes", () => {
	const first = evaluateWorkerExit({
		exitCode: 1,
		restartRequested: false,
		restartAttempts: 0,
		maxRestarts: 5,
		restartDelayMs: 10,
	});
	assert.deepEqual(first, {
		action: "restart",
		reason: "crash",
		exitCode: null,
		restartAttempts: 1,
		delayMs: 10,
	});

	const second = evaluateWorkerExit({
		exitCode: 1,
		restartRequested: false,
		restartAttempts: first.restartAttempts,
		maxRestarts: 5,
		restartDelayMs: 10,
	});
	assert.equal(second.action, "restart");
	assert.equal(second.restartAttempts, 2);
	assert.equal(second.delayMs, 20);
});

test("evaluateWorkerExit exits once MAX_RESTARTS is exceeded", () => {
	const result = evaluateWorkerExit({
		exitCode: 2,
		restartRequested: false,
		restartAttempts: 5,
		maxRestarts: 5,
		restartDelayMs: 10,
	});

	assert.deepEqual(result, {
		action: "exit",
		reason: "max-restarts",
		exitCode: 2,
		restartAttempts: 6,
		delayMs: null,
	});
});

test("evaluateWorkerExit resets restartAttempts after long stable runtime", () => {
	const result = evaluateWorkerExit({
		exitCode: 1,
		restartRequested: false,
		runtimeMs: 20_000,
		safeRuntimeResetWindowMs: 10_000,
		restartAttempts: 4,
		maxRestarts: 5,
		restartDelayMs: 10,
	});

	assert.equal(result.action, "restart");
	assert.equal(result.restartAttempts, 1);
	assert.equal(result.delayMs, 10);
});

test("clearRestartFlagSync returns false when missing", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-restartflag-"),
	);
	const flagPath = path.join(tempDir, "restart.flag");
	try {
		assert.equal(clearRestartFlagSync(flagPath, { fsModule: fs }), false);
	} finally {
		await fsPromises.rm(tempDir, { recursive: true, force: true });
	}
});

test("consumeRestartFlagSync returns not-requested when missing", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-restartflag-"),
	);
	const flagPath = path.join(tempDir, "restart.flag");
	try {
		assert.deepEqual(consumeRestartFlagSync(flagPath, { fsModule: fs }), {
			requested: false,
			reason: "manual",
			targetVersion: null,
		});
	} finally {
		await fsPromises.rm(tempDir, { recursive: true, force: true });
	}
});

test("clearRestartFlagSync removes restart.flag when present", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-restartflag-"),
	);
	const flagPath = path.join(tempDir, "restart.flag");
	try {
		await fsPromises.writeFile(flagPath, "");
		assert.equal(clearRestartFlagSync(flagPath, { fsModule: fs }), true);
		await assert.rejects(() => fsPromises.stat(flagPath), /ENOENT/);
	} finally {
		await fsPromises.rm(tempDir, { recursive: true, force: true });
	}
});

test("consumeRestartFlagSync parses empty payload as manual request", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-restartflag-"),
	);
	const flagPath = path.join(tempDir, "restart.flag");
	try {
		await fsPromises.writeFile(flagPath, "");
		assert.deepEqual(consumeRestartFlagSync(flagPath, { fsModule: fs }), {
			requested: true,
			reason: "manual",
			targetVersion: null,
		});
	} finally {
		await fsPromises.rm(tempDir, { recursive: true, force: true });
	}
});

test("consumeRestartFlagSync parses update payload and target version", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-restartflag-"),
	);
	const flagPath = path.join(tempDir, "restart.flag");
	try {
		await fsPromises.writeFile(
			flagPath,
			JSON.stringify({
				reason: "update",
				requestedAt: Date.now(),
				targetVersion: "v9.9.9",
			}),
		);
		assert.deepEqual(consumeRestartFlagSync(flagPath, { fsModule: fs }), {
			requested: true,
			reason: "update",
			targetVersion: "v9.9.9",
		});
	} finally {
		await fsPromises.rm(tempDir, { recursive: true, force: true });
	}
});

test("consumeRestartFlagSync falls back to manual for invalid payload", async () => {
	const tempDir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "wa2dc-restartflag-"),
	);
	const flagPath = path.join(tempDir, "restart.flag");
	try {
		await fsPromises.writeFile(flagPath, "{bad-json");
		assert.deepEqual(consumeRestartFlagSync(flagPath, { fsModule: fs }), {
			requested: true,
			reason: "manual",
			targetVersion: null,
		});
	} finally {
		await fsPromises.rm(tempDir, { recursive: true, force: true });
	}
});

test("clearRestartFlagSync treats ENOENT unlink races as success", () => {
	const calls = [];
	const logger = { warn: (...args) => calls.push(args) };
	const fakeFs = {
		existsSync: () => true,
		readFileSync: () => "",
		unlinkSync: () => {
			const err = new Error("gone");
			err.code = "ENOENT";
			throw err;
		},
	};

	assert.equal(
		clearRestartFlagSync("restart.flag", { logger, fsModule: fakeFs }),
		true,
	);
	assert.equal(calls.length, 0);
});

test("parseRestartFlagPayload ignores unsupported reason and blank version", () => {
	assert.deepEqual(
		parseRestartFlagPayload(
			JSON.stringify({ reason: "unknown", targetVersion: "   " }),
		),
		{ reason: "manual", targetVersion: null },
	);
});

test("resolveRollbackBackupCandidates returns cwd + exec-path candidates", () => {
	const cwd = path.join(path.sep, "tmp", "app");
	const execPath = path.join(path.sep, "opt", "bin", "WA2DC");
	const cwdCandidate = path.resolve(cwd, "WA2DC.oldVersion");
	const execCandidate = path.join(path.dirname(execPath), "WA2DC.oldVersion");

	const candidates = resolveRollbackBackupCandidates({
		currentExeName: "WA2DC",
		execPath,
		cwd,
	});
	assert.deepEqual(candidates, [cwdCandidate, execCandidate]);
});

test("findRollbackBackupPathSync returns first existing candidate", () => {
	const cwd = path.join(path.sep, "tmp", "app");
	const execPath = path.join(path.sep, "opt", "bin", "WA2DC");
	const expected = path.resolve(cwd, "WA2DC.oldVersion");

	const fakeFs = {
		existsSync(value) {
			return value === expected;
		},
	};

	assert.equal(
		findRollbackBackupPathSync({
			currentExeName: "WA2DC",
			execPath,
			cwd,
			fsModule: fakeFs,
		}),
		expected,
	);
});

test("revertExecutableToBackupSync succeeds when backup exists", () => {
	const cwd = path.join(path.sep, "tmp", "app");
	const execPath = path.join(path.sep, "opt", "bin", "WA2DC");
	const expectedBackup = path.resolve(cwd, "WA2DC.oldVersion");

	const calls = [];
	const fakeFs = {
		existsSync(value) {
			return value === expectedBackup;
		},
		rmSync(target, options) {
			calls.push(["rmSync", target, options]);
		},
		renameSync(from, to) {
			calls.push(["renameSync", from, to]);
		},
	};

	const result = revertExecutableToBackupSync({
		currentExeName: "WA2DC",
		execPath,
		cwd,
		fsModule: fakeFs,
	});

	assert.equal(result.success, true);
	assert.equal(result.backupPath, expectedBackup);
	assert.equal(result.currentPath, execPath);
	assert.deepEqual(calls, [
		["rmSync", execPath, { force: true }],
		["renameSync", expectedBackup, execPath],
	]);
});

test("revertExecutableToBackupSync returns no-backup when candidates are missing", () => {
	const fakeFs = {
		existsSync() {
			return false;
		},
		rmSync() {
			throw new Error("should not be called");
		},
		renameSync() {
			throw new Error("should not be called");
		},
	};

	assert.deepEqual(
		revertExecutableToBackupSync({
			currentExeName: "WA2DC",
			execPath: "/opt/bin/WA2DC",
			cwd: "/tmp/app",
			fsModule: fakeFs,
		}),
		{ success: false, reason: "no-backup" },
	);
});

test("revertExecutableToBackupSync reports rename failures", () => {
	const fakeFs = {
		existsSync() {
			return true;
		},
		rmSync() {},
		renameSync() {
			throw new Error("rename denied");
		},
	};

	const result = revertExecutableToBackupSync({
		currentExeName: "WA2DC",
		execPath: "/opt/bin/WA2DC",
		cwd: "/tmp/app",
		fsModule: fakeFs,
	});

	assert.equal(result.success, false);
	assert.equal(result.reason, "rename-failed");
});

test("revertPackagedArtifactsToBackupSync restores runtime sidecar alongside executable", () => {
	const pathModule = path.posix;
	const execPath = "/opt/bin/WA2DC";
	const runtimePath = pathModule.join(pathModule.dirname(execPath), "runtime");
	const expectedBackup = `${execPath}.oldVersion`;
	const runtimeBackup = `${runtimePath}.oldVersion`;
	const calls = [];
	const fakeFs = {
		existsSync(value) {
			return value === expectedBackup || value === runtimeBackup;
		},
		rmSync(target, options) {
			calls.push(["rmSync", target, options]);
		},
		renameSync(from, to) {
			calls.push(["renameSync", from, to]);
		},
	};

	const result = revertPackagedArtifactsToBackupSync({
		currentExeName: "WA2DC",
		execPath,
		cwd: "/tmp/app",
		fsModule: fakeFs,
		pathModule,
	});

	assert.equal(result.success, true);
	assert.equal(result.backupPath, expectedBackup);
	assert.equal(result.currentPath, execPath);
	assert.equal(result.runtimeBackupPath, runtimeBackup);
	assert.equal(result.runtimePath, runtimePath);
	assert.deepEqual(calls, [
		["rmSync", execPath, { force: true }],
		["renameSync", expectedBackup, execPath],
		["rmSync", runtimePath, { recursive: true, force: true }],
		["renameSync", runtimeBackup, runtimePath],
	]);
});

test("revertPackagedArtifactsToBackupSync restores packaged artifacts with win32 paths", () => {
	const pathModule = path.win32;
	const execPath = "D:\\app\\WA2DC.exe";
	const runtimePath = pathModule.join(pathModule.dirname(execPath), "runtime");
	const expectedBackup = `${execPath}.oldVersion`;
	const runtimeBackup = `${runtimePath}.oldVersion`;
	const calls = [];
	const fakeFs = {
		existsSync(value) {
			return value === expectedBackup || value === runtimeBackup;
		},
		rmSync(target, options) {
			calls.push(["rmSync", target, options]);
		},
		renameSync(from, to) {
			calls.push(["renameSync", from, to]);
		},
	};

	const result = revertPackagedArtifactsToBackupSync({
		currentExeName: "WA2DC.exe",
		execPath,
		cwd: "D:\\app",
		fsModule: fakeFs,
		pathModule,
	});

	assert.equal(result.success, true);
	assert.equal(result.backupPath, expectedBackup);
	assert.equal(result.currentPath, execPath);
	assert.equal(result.runtimeBackupPath, runtimeBackup);
	assert.equal(result.runtimePath, runtimePath);
	assert.deepEqual(calls, [
		["rmSync", execPath, { force: true }],
		["renameSync", expectedBackup, execPath],
		["rmSync", runtimePath, { recursive: true, force: true }],
		["renameSync", runtimeBackup, runtimePath],
	]);
});

test("evaluateUpdateValidationExit reaches rollback threshold on second crash", () => {
	const initialState = {
		active: true,
		crashCount: 0,
		rollbackAttempted: false,
		version: "v9.9.9",
	};
	const first = evaluateUpdateValidationExit({
		validationState: initialState,
		exitCode: 1,
		runtimeMs: 30_000,
		healthyWindowMs: 120_000,
	});

	assert.equal(first.shouldAttemptRollback, false);
	assert.equal(first.validationState.crashCount, 1);

	const second = evaluateUpdateValidationExit({
		validationState: first.validationState,
		exitCode: 1,
		runtimeMs: 40_000,
		healthyWindowMs: 120_000,
	});

	assert.equal(second.shouldAttemptRollback, true);
	assert.equal(second.validationState.rollbackAttempted, true);
});
