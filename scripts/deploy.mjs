import * as fs from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FILES, validateManifest, extensionId } from './package.mjs';

const digest = (b) => createHash('sha256').update(b).digest('hex');
function replaceFile(path, bytes) {
  const temp = join(dirname(path), `.qf-deploy-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, path);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function checkEntryPath(base, name) {
  const pieces = name.split('/');
  let path = base;
  for (const piece of pieces) {
    path = join(path, piece);
    let stat;
    try {
      stat = fs.lstatSync(path);
    } catch (e) {
      if (e.code === 'ENOENT') break;
      throw e;
    }
    if (stat.isSymbolicLink())
      throw Error('Symlinked runtime/build paths are not supported');
    if (piece !== pieces.at(-1) && !stat.isDirectory())
      throw Error('Entry parent must be a directory');
  }
}
/** Publish verified files individually; keep the installed directory present and
 * replace manifest last. Roll back touched files on a publication failure. */
export function deployExtension(candidate, installed, backup, expectedVersion) {
  const source = resolve(candidate),
    target = resolve(installed),
    saved = resolve(backup);
  if (source === target || saved === target || saved.startsWith(target + '/'))
    throw Error('Unsafe deployment paths');
  if (fs.lstatSync(source).isSymbolicLink())
    throw Error('Build must be a real directory');
  for (const name of FILES) {
    checkEntryPath(source, name);
    checkEntryPath(target, name);
  }
  const m = JSON.parse(fs.readFileSync(join(source, 'manifest.json')));
  validateManifest(m, expectedVersion);
  const files = new Map(
    FILES.map((name) => [name, fs.readFileSync(join(source, name))]),
  );
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
    throw Error('Runtime must be a real directory');
  const oldManifest = join(target, 'manifest.json');
  if (fs.existsSync(oldManifest)) {
    const old = JSON.parse(fs.readFileSync(oldManifest));
    if (!old.key || extensionId(old.key) !== extensionId(m.key))
      throw Error('Installed extension ID differs; refusing update');
  }
  for (const name of FILES) {
    const path = join(target, name);
    if (fs.existsSync(path) && !fs.lstatSync(path).isFile())
      throw Error('Runtime entry must be a regular file');
  }
  if (fs.existsSync(saved))
    throw Error('Refusing to overwrite rollback backup');
  fs.mkdirSync(dirname(saved), { recursive: true });
  if (fs.existsSync(target))
    fs.cpSync(target, saved, { recursive: true, errorOnExist: true });
  else fs.mkdirSync(saved);
  fs.mkdirSync(target, { recursive: true });
  const order = FILES.filter((n) => n !== 'manifest.json').concat(
      'manifest.json',
    ),
    changed = [];
  try {
    for (const name of order) {
      const path = join(target, name);
      fs.mkdirSync(dirname(path), { recursive: true });
      replaceFile(path, files.get(name));
      changed.push(name);
    }
    for (const [name, bytes] of files)
      if (digest(fs.readFileSync(join(target, name))) !== digest(bytes))
        throw Error('Runtime verification failed');
  } catch (error) {
    const failures = [];
    for (const name of changed.reverse()) {
      try {
        const old = join(saved, name);
        if (fs.existsSync(old))
          replaceFile(join(target, name), fs.readFileSync(old));
        else fs.unlinkSync(join(target, name));
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        `Update failed; restore runtime from ${saved}`,
      );
    throw error;
  }
  return {
    version: m.version,
    extensionId: extensionId(m.key),
    installed: target,
    backup: saved,
    files: FILES.map((name) => ({ name, sha256: digest(files.get(name)) })),
  };
}
function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, ['esbuild.config.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });
  const version = JSON.parse(
    fs.readFileSync(join(root, 'package.json')),
  ).version;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = resolve(
    root,
    '../quick-fill-backups',
    `runtime-before-${version}-${stamp}`,
  );
  const result = deployExtension(
    join(root, '.build/extension'),
    join(root, 'dist'),
    backup,
    version,
  );
  result.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  fs.mkdirSync(join(root, 'release-evidence'), { recursive: true });
  fs.writeFileSync(
    join(root, 'release-evidence', `deployment-${version}.json`),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
