import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPublicFiles, scanText } from '../scripts/public-source.mjs';

const script = fileURLToPath(new URL('../scripts/public-source.mjs', import.meta.url));
const token = ['ghp', '_', 'A'.repeat(36)].join('');
const privateHeader = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'qf-public-source-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (name, text) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'Synthetic source fixture'); return git('rev-parse', 'HEAD'); };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  put('.gitignore', 'node_modules/\n');
  put('LICENSE', 'MIT License\nSynthetic fixture\n'); put('.nvmrc', '24\n');
  put('package.json', JSON.stringify({ name: 'synthetic-fixture', version: '1.2.3' }));
  put('manifest.json', JSON.stringify({ key: 'PUBLIC_MANIFEST_KEY', version: '1.2.3' }));
  put('src/main.ts', 'export const value = 1;\n');
  put('docs/PRIVACY.md', '# Privacy\n'); put('docs/SECURITY.md', '# Security\n');
  put('docs/ARCHITECTURE.md', '# Architecture\n'); put('docs/PUBLIC_README.md', '# Public project\n');
  commit();
  return { root, git, put, commit, run, evidence: () => JSON.parse(readFileSync(join(root, 'release-evidence/public-source-scan-1.2.3.json'), 'utf8')) };
}

test('selects only public source inputs, maps the public README, and excludes private/output paths', () => {
  const allowed = ['LICENSE', '.nvmrc', '.gitignore', 'src/main.ts', 'public/icon.png', 'test/example.test.ts', 'scripts/build.mjs', '.github/workflows/verify.yml', 'package.json', 'package-lock.json', 'manifest.json', 'tsconfig.json', 'vitest.config.ts', 'esbuild.config.mjs', 'AGENTS.md', 'PRODUCT.md', 'docs/PRIVACY.md', 'docs/SECURITY.md', 'docs/ARCHITECTURE.md'];
  const denied = ['.git/config', 'dist/content.js', '.build/extension/content.js', 'node_modules/pkg/index.js', 'releases/source.zip', 'release-evidence/result.json', 'docs/HandOff.md', 'docs/private-notes.md', 'exports/vault.json', '../src/outside.ts', '/src/absolute.ts', 'src/../private.ts', 'src/.env', 'src/.env.local', 'public/private.pem', 'scripts/signing.key', 'src/backups/profile.json', 'src/exports/profile.json', 'test/credentials.json', 'src/HandOff-export.json', 'public/source.js.map'];
  const selected = selectPublicFiles([...allowed, ...denied, 'docs/PUBLIC_README.md']);
  assert.deepEqual(selected, [...allowed.map(source => ({ source, path: source })), { source: 'docs/PUBLIC_README.md', path: 'README.md' }, { source: 'docs/PUBLIC_README.md', path: 'docs/PUBLIC_README.md' }].sort((a, b) => a.path.localeCompare(b.path)));
});

test('reports high confidence token/private-key rules without returning their values', () => {
  const secrets = [privateHeader, token, ['github', '_pat_', 'B'.repeat(82)].join(''), ['sk', '-', 'C'.repeat(48)].join(''), ['AKIA', 'D'.repeat(16)].join('')];
  const rules = scanText(secrets.join('\n'));
  assert.deepEqual(rules.sort(), ['aws-access-key', 'github-token', 'openai-token', 'private-key'].sort());
  assert.ok(secrets.every(secret => !JSON.stringify(rules).includes(secret)));
  assert.deepEqual(scanText('-----BEGIN PUBLIC KEY-----\nPUBLIC_MANIFEST_KEY\n-----END PUBLIC KEY-----'), []);
  assert.deepEqual(scanText('ghp_example sk-short AKIAshort'), []);
});

test('reports personal home paths while allowing documented placeholders and temporary paths', () => {
  for (const family of ['Users', 'home']) assert.deepEqual(scanText(['', family, 'somebody', 'project'].join('/')), ['personal-path']);
  assert.deepEqual(scanText(['/tmp/project', ['', 'Users', '<user>', 'project'].join('/'), ['', 'home', '{user}', 'project'].join('/')].join('\n')), []);
});

test('scan-only detects deleted historical secrets and emits metadata without secret values', t => {
  const repo = repository(t);
  repo.put('src/old.ts', `export const token = '${token}';\n`);
  const secretCommit = repo.commit();
  repo.put('src/old.ts', 'export const token = null;\n'); repo.commit();
  repo.put('backups/private.json', token); repo.commit();
  const result = repo.run('--scan-only');
  assert.equal(result.status, 1);
  const evidence = repo.evidence();
  assert.equal(evidence.status, 'failed');
  assert.ok(evidence.findings.some(finding => finding.commit === secretCommit && finding.path === 'src/old.ts' && finding.rule === 'github-token'));
  assert.ok(evidence.findings.some(finding => finding.path === 'backups/private.json' && finding.rule === 'github-token'));
  assert.ok(!JSON.stringify(evidence).includes(token)); assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes(token));
  assert.ok(!existsSync(join(repo.root, 'releases/quick-fill-source-v1.2.3.zip')));
});

test('scan-only rejects a personal path in current public source, including uncommitted source', t => {
  const repo = repository(t);
  repo.put('src/local.ts', `const path = '${['', 'Users', 'somebody', 'private'].join('/')}';\n`);
  const result = repo.run('--scan-only');
  assert.equal(result.status, 1);
  assert.ok(repo.evidence().findings.some(finding => finding.commit === 'working-tree' && finding.path === 'src/local.ts' && finding.rule === 'personal-path'));
});

test('fails clearly when required public documentation is missing', t => {
  const repo = repository(t);
  rmSync(join(repo.root, 'docs/PUBLIC_README.md')); repo.commit();
  const result = repo.run('--scan-only');
  assert.equal(result.status, 1);
  assert.ok(repo.evidence().findings.some(finding => finding.path === 'docs/PUBLIC_README.md' && finding.rule === 'required-file-missing'));
});

test('exports only committed allowlisted files, hashes the archive and every entry, and refuses overwrites', t => {
  const repo = repository(t);
  repo.put('backups/private.json', '{"synthetic":true}'); repo.put('docs/HandOff.md', 'Private handoff'); repo.put('dist/runtime.js', 'Installed runtime'); repo.commit();
  const head = repo.git('rev-parse', 'HEAD');
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  const zip = join(repo.root, 'releases/quick-fill-source-v1.2.3.zip');
  const manifest = JSON.parse(readFileSync(join(repo.root, 'releases/quick-fill-source-v1.2.3.json'), 'utf8'));
  assert.equal(manifest.sourceCommit, head);
  assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(zip)).digest('hex'));
  const entries = execFileSync('unzip', ['-Z', '-1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(entries, manifest.files.map(file => file.path).sort());
  assert.ok(entries.includes('README.md')); assert.ok(entries.includes('LICENSE')); assert.ok(entries.includes('.nvmrc')); assert.ok(entries.includes('docs/PUBLIC_README.md'));
  assert.equal(execFileSync('unzip',['-p',zip,'README.md'],{encoding:'utf8'}),execFileSync('unzip',['-p',zip,'docs/PUBLIC_README.md'],{encoding:'utf8'}));
  for (const file of manifest.files) assert.equal(file.sha256, createHash('sha256').update(execFileSync('unzip', ['-p', zip, file.path])).digest('hex'));
  const roundtrip = join(repo.root,'roundtrip'); mkdirSync(roundtrip);
  execFileSync('unzip',['-q',zip,'-d',roundtrip]);
  const publicGit=(...args)=>execFileSync('git',args,{cwd:roundtrip,stdio:'pipe'});
  publicGit('init','-q');publicGit('config','user.name','Synthetic Public');publicGit('config','user.email','public@example.invalid');publicGit('add','.');publicGit('commit','-qm','Synthetic public snapshot');
  const rescanned=spawnSync(process.execPath,[script,'--scan-only'],{cwd:roundtrip,encoding:'utf8'});
  assert.equal(rescanned.status,0,rescanned.stdout+rescanned.stderr);
  assert.equal(repo.run().status, 1);
});

test('refuses packaging a dirty tracked tree or uncommitted selected source', t => {
  const repo = repository(t);
  repo.put('src/main.ts', 'export const value = 2;\n');
  assert.equal(repo.run().status, 1);
  assert.ok(!existsSync(join(repo.root, 'releases/quick-fill-source-v1.2.3.zip')));
  repo.git('checkout', '--', 'src/main.ts');
  repo.put('src/new.ts', 'export const value = 3;\n');
  assert.equal(repo.run().status, 1);
});

test('does not follow a replaced source directory into private files', t => {
  const repo = repository(t);
  repo.put('backups/main.ts', token);
  rmSync(join(repo.root, 'src'), { recursive: true });
  symlinkSync(join(repo.root, 'backups'), join(repo.root, 'src'));
  const result = repo.run('--scan-only');
  assert.equal(result.status, 1);
  const evidence = repo.evidence();
  assert.ok(evidence.findings.some(finding => finding.path === 'src/main.ts' && finding.rule === 'unsupported-file-type'));
  assert.ok(evidence.findings.every(finding => finding.rule !== 'github-token'));
});

test('excludes nested project recovery assets regardless of filename extension', () => {
  assert.deepEqual(selectPublicFiles([
    'src/quick-fill-backups/opaque.txt',
    'public/browser-storage-recovery-20261017/opaque.log',
    'test/fixtures/quick-fill-backups/opaque.json',
  ]), []);
});

test('recognizes additional high-confidence API and signed-token patterns without printing values',()=>{
 const inputs=[['AIza','A'.repeat(35)].join(''),['xoxb','-', 'B'.repeat(30)].join(''),['eyJ','C'.repeat(20),'.','D'.repeat(20),'.','E'.repeat(25)].join('')];
 assert.deepEqual(scanText(inputs.join(' ')).sort(),['google-api-key','jwt-token','slack-token']);
 assert(inputs.every(input=>!JSON.stringify(scanText(input)).includes(input)));
});
