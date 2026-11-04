import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const FILES = [
  'manifest.json',
  'LICENSE',
  'background.js',
  'content.js',
  'popup.js',
  'popup.html',
  'popup.css',
  'options.js',
  'options.html',
  'options.css',
  'diagnostics.js',
  'diagnostics.html',
  'INSTALL.txt',
  'unlock.html',
  'unlock.css',
  'unlock.js',
  ...['16', '32', '48', '128'].map((n) => `icons/icon-${n}.png`),
];
export function extensionId(key) {
  return createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}
export function validateManifest(manifest, version) {
  if (
    manifest.manifest_version !== 3 ||
    manifest.version !== version ||
    !manifest.key
  )
    throw Error('Manifest/version/key mismatch');
  if (extensionId(manifest.key) !== 'neilinbkkjgcnflgamepebchiapfcibm')
    throw Error('Extension ID changed');
  if (
    JSON.stringify([...manifest.permissions].sort()) !==
    JSON.stringify(['alarms', 'storage'])
  )
    throw Error('Unexpected permissions');
  const supported = ['http://*/*', 'https://*/*'];
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(supported) ||
      manifest.content_scripts?.length !== 1 || JSON.stringify(manifest.content_scripts[0].matches) !== JSON.stringify(supported))
    throw Error('Unexpected host/content protocols');
  if (JSON.stringify(manifest.web_accessible_resources) !== JSON.stringify([{
    resources: ['unlock.html', 'unlock.js', 'unlock.css'],
    matches: ['http://*/*', 'https://*/*'],
  }])) throw Error('Unexpected web-accessible resources');
}

export function validateEntries(entries) {
  if (
    entries.length !== FILES.length ||
    entries.some((n) => !FILES.includes(n)) ||
    new Set(entries).size !== FILES.length
  )
    throw Error('Package file allowlist mismatch');
}
function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const version = JSON.parse(
    readFileSync(resolve(root, 'package.json')),
  ).version;
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json')));
  validateManifest(manifest, version);
  execFileSync(process.execPath, ['esbuild.config.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });
  const dist = resolve(root, '.build/extension'),
    releases = resolve(root, 'releases');
  mkdirSync(releases, { recursive: true });
  for (const n of ['16', '32', '48', '128']) {
    const b = readFileSync(resolve(dist, `icons/icon-${n}.png`));
    if (b.readUInt32BE(16) !== Number(n) || b.readUInt32BE(20) !== Number(n))
      throw Error('Icon size mismatch');
  }
  const zip = resolve(releases, `quick-fill-v${version}.zip`);
  if (existsSync(zip))
    throw Error(
      'Refusing to overwrite existing release ZIP; use a new version or archive the candidate',
    );
  execFileSync('zip', ['-X', '-q', zip, ...FILES], { cwd: dist });
  const entries = execFileSync('unzip', ['-Z', '-1', zip], { encoding: 'utf8' })
    .trim()
    .split('\n');
  validateEntries(entries);
  execFileSync('unzip', ['-t', zip], { stdio: 'pipe' });
  const record = {
    version,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    extensionId: extensionId(manifest.key),
    file: zip,
    sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'),
    files: FILES.map((name) => ({
      name,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(dist, name)))
        .digest('hex'),
    })),
  };
  writeFileSync(
    resolve(releases, `quick-fill-v${version}.json`),
    JSON.stringify(record, null, 2) + '\n',
  );
  console.log(JSON.stringify(record, null, 2));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
