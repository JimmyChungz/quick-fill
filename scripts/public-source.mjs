import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_FILES = new Set([
  'LICENSE', '.nvmrc', '.gitignore', 'package.json', 'package-lock.json', 'manifest.json', 'tsconfig.json',
  'vitest.config.ts', 'esbuild.config.mjs', 'AGENTS.md', 'PRODUCT.md',
  'docs/PRIVACY.md', 'docs/SECURITY.md', 'docs/ARCHITECTURE.md', 'docs/PUBLIC_README.md', 'qa/login-fixture-server.mjs',
]);
const REQUIRED = ['LICENSE', '.nvmrc', '.gitignore', 'package.json', 'manifest.json', 'docs/PRIVACY.md', 'docs/SECURITY.md', 'docs/ARCHITECTURE.md', 'docs/PUBLIC_README.md'];
const PRIVATE_PATH = /(^|\/)(?:\.git|dist|\.build|node_modules|releases|release-evidence|evidence|backups?|exports?|handoffs?)(\/|$)/i;
const PRIVATE_FILE = /(?:handoff.*|(?:.*[-_.])?(?:backup|export|credentials)(?:[-_.].*)?)\.(?:json|txt|md|zip)$/i;
const RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['github-token', /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{36,})\b/],
  ['openai-token', /\bsk-[A-Za-z0-9_-]{32,}\b/],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['jwt-token', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\b/],
];

function privatePath(path) {
  return /(^|\/)(?:quick-fill-backups|browser-storage-recovery-[^/]*)(\/|$)/i.test(path) || PRIVATE_PATH.test(path) || PRIVATE_FILE.test(path.split('/').at(-1));
}

/** The destination name is explicit: the private project README is never used. */
export function selectPublicFiles(paths) {
  return [...new Set(paths)].filter(path => {
    if (typeof path !== 'string' || path.startsWith('/') || /[\\\x00-\x1f]/.test(path)
      || path.split('/').some(part => part === '.' || part === '..' || part === '') || privatePath(path)) return false;
    if (/(^|\/)\.env(?:\.|$)/i.test(path) || /\.(?:pem|key|p12|pfx|jks|keystore|zip|crx|map|sqlite|db)$/i.test(path)) return false;
    return ROOT_FILES.has(path) || /^(?:src|public|test|scripts|\.github)\//.test(path);
  }).map(source => ({ source, path: source === 'docs/PUBLIC_README.md' ? 'README.md' : source }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Return rule names only. Never return a matched value or surrounding source. */
export function scanText(text) {
  const rules = RULES.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
  if (/\/(?:Users|home)\/(?!<|\{|\$\{)[^/\s"'`]+(?:\/|$)/.test(text)) rules.push('personal-path');
  return rules;
}

function git(root, args, binary = false) {
  return execFileSync('git', args, {
    cwd: root, encoding: binary ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const list = text => text.split('\0').filter(Boolean);
const finding = (path, rule, commit = 'working-tree') => ({ commit, path, rule });

function hasSymlink(root, source) {
  let path = root;
  for (const part of source.split('/')) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return false;
}

function scanHistory(root) {
  const commits = git(root, ['rev-list', '--all']).trim().split('\n').filter(Boolean);
  const seen = new Set(), findings = [];
  let textBlobs = 0;
  for (const commit of commits) {
    for (const entry of list(git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]))) {
      const tab = entry.indexOf('\t');
      const [, type, oid] = entry.slice(0, tab).split(' '), path = entry.slice(tab + 1);
      if (type !== 'blob' || seen.has(oid)) continue;
      seen.add(oid);
      const bytes = git(root, ['cat-file', 'blob', oid], true);
      if (bytes.includes(0)) continue;
      textBlobs++;
      // Home paths are a current-public-source check. History checks actual secret patterns.
      for (const rule of scanText(bytes.toString('utf8')).filter(rule => rule !== 'personal-path')) {
        findings.push(finding(path, rule, commit));
      }
    }
  }
  return { commits: commits.length, uniqueBlobs: seen.size, uniqueTextBlobs: textBlobs, findings };
}

function cleanSource(root, sources) {
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=no']).trim()) return 'tracked-source-dirty';
  const tracked = new Set(list(git(root, ['ls-files', '-z', '--cached'])));
  return sources.some(file => !tracked.has(file.source)) ? 'public-source-uncommitted' : null;
}

function archive(root, version, sourceCommit, sources) {
  const directory = join(root, 'releases');
  const name = `quick-fill-source-v${version}`;
  const zip = join(directory, `${name}.zip`), manifestPath = join(directory, `${name}.json`);
  if (existsSync(zip) || existsSync(manifestPath)) return { rule: 'release-already-exists' };
  const staging = mkdtempSync(join(tmpdir(), 'quick-fill-public-source-'));
  try {
    const tree = join(staging, 'tree');
    for (const file of sources) {
      const target = join(tree, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { mode: file.mode & 0o777 });
    }
    const temporaryZip = join(staging, `${name}.zip`);
    execFileSync('zip', ['-X', '-q', temporaryZip, ...sources.map(file => file.path)], { cwd: tree, stdio: 'pipe' });
    execFileSync('unzip', ['-t', temporaryZip], { stdio: 'pipe' });
    const entries = execFileSync('unzip', ['-Z', '-1', temporaryZip], { encoding: 'utf8' }).trim().split('\n').sort();
    const expected = sources.map(file => file.path).sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) return { rule: 'archive-entries-mismatch' };
    const record = {
      version, sourceCommit, file: `${name}.zip`, sha256: sha256(readFileSync(temporaryZip)),
      files: sources.map(({ source, path, bytes }) => ({ source, path, sha256: sha256(bytes) })),
    };
    mkdirSync(directory, { recursive: true });
    copyFileSync(temporaryZip, zip, constants.COPYFILE_EXCL);
    writeFileSync(manifestPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    return { record };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--scan-only') || args.length > 1) {
    throw new Error('Use node scripts/public-source.mjs [--scan-only]');
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version');
  const sourceCommit = git(root, ['rev-parse', 'HEAD']).trim();
  const paths = list(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  const selected = selectPublicFiles(paths), findings = [], sources = [];
  for (const required of REQUIRED) {
    if (!paths.includes(required) || !existsSync(join(root, required))) findings.push(finding(required, 'required-file-missing'));
  }
  for (const file of selected) {
    const path = join(root, file.source);
    if (hasSymlink(root, file.source)) { findings.push(finding(file.source, 'unsupported-file-type')); continue; }
    if (!existsSync(path)) { findings.push(finding(file.source, 'selected-file-missing')); continue; }
    const stat = lstatSync(path);
    if (!stat.isFile()) { findings.push(finding(file.source, 'unsupported-file-type')); continue; }
    const bytes = readFileSync(path);
    sources.push({ ...file, bytes, mode: stat.mode });
    if (!bytes.includes(0)) for (const rule of scanText(bytes.toString('utf8'))) findings.push(finding(file.source, rule));
  }
  const history = scanHistory(root);
  findings.push(...history.findings);
  let output;
  if (!args.includes('--scan-only') && findings.length === 0) {
    const dirty = cleanSource(root, sources);
    if (dirty) findings.push(finding('.', dirty));
    else if (git(root, ['rev-parse', 'HEAD']).trim() !== sourceCommit) findings.push(finding('.', 'source-commit-changed'));
    else {
      output = archive(root, version, sourceCommit, sources);
      if (output.rule) findings.push(finding('releases/', output.rule));
    }
  }
  const record = {
    version, sourceCommit, scannedAt: new Date().toISOString(), status: findings.length ? 'failed' : 'passed',
    selectedFiles: selected, currentFiles: sources.length,
    history: { commits: history.commits, uniqueBlobs: history.uniqueBlobs, uniqueTextBlobs: history.uniqueTextBlobs },
    findings, ...(output?.record ? { archive: output.record } : {}),
  };
  const evidence = join(root, 'release-evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `public-source-scan-${version}.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch {
    // Child-process errors can include source output; never forward their text.
    console.error(JSON.stringify({ status: 'failed', rule: 'public-source-command-failed', message: 'Public source scan/export could not complete. Check Git, package metadata, file access, and zip/unzip availability.' }));
    process.exitCode = 1;
  }
}
