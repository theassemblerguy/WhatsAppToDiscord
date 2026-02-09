import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function platformToPkgOs(platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return null;
}

function archToPkgArch(arch) {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...(process.platform === 'win32' ? { shell: true } : null),
    ...options,
  });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

function getBin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function buildOutputPath(pkgOs, pkgArch) {
  fs.mkdirSync('build', { recursive: true });

  if (pkgOs === 'win') {
    return pkgArch === 'x64' ? path.join('build', 'WA2DC.exe') : path.join('build', `WA2DC-${pkgArch}.exe`);
  }

  if (pkgOs === 'linux') {
    return pkgArch === 'x64' ? path.join('build', 'WA2DC-Linux') : path.join('build', `WA2DC-Linux-${pkgArch}`);
  }

  if (pkgOs === 'macos') {
    return pkgArch === 'x64' ? path.join('build', 'WA2DC-macOS') : path.join('build', `WA2DC-macOS-${pkgArch}`);
  }

  throw new Error(`Unsupported pkg OS: ${pkgOs}`);
}

const args = new Set(process.argv.slice(2));
const shouldSmokeTest = args.has('--smoke');
const nodeMajor = process.env.WA2DC_PKG_NODE_MAJOR || '24';

const pkgOs = platformToPkgOs(process.platform);
const pkgArch = archToPkgArch(process.arch);

if (!pkgOs) throw new Error(`Unsupported platform: ${process.platform}`);
if (!pkgArch) throw new Error(`Unsupported architecture: ${process.arch}`);

const target = `node${nodeMajor}-${pkgOs}-${pkgArch}`;
const outputPath = buildOutputPath(pkgOs, pkgArch);
const resolvedOutputPath = path.resolve(outputPath);

run(getBin('npm'), ['run', 'bundle']);

const pkgArgs = [
  '-y',
  '@yao-pkg/pkg',
  'out.cjs',
  '-t',
  target,
  '--options',
  'no-warnings',
  '-o',
  outputPath,
];

if (pkgOs === 'win' || pkgArch === 'arm64') {
  pkgArgs.push('--no-bytecode', '--public', '--public-packages', '*');
}

run(getBin('npx'), pkgArgs);

if (shouldSmokeTest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa2dc-pkg-smoke-'));
  run(resolvedOutputPath, [], { cwd: tmp, env: { ...process.env, WA2DC_SMOKE_TEST: '1' } });
}
