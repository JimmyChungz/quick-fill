import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FILES } from '../scripts/package.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture() {
  return fs.mkdtempSync(join(tmpdir(), 'qf-stability-test-'));
}
test('building never deletes the installed runtime directory or its manifest', () => {
  const dir = fixture();
  try {
    for (const name of ['src', 'public'])
      fs.cpSync(join(root, name), join(dir, name), { recursive: true });
    for (const name of ['esbuild.config.mjs', 'manifest.json', 'package.json', 'LICENSE'])
      fs.copyFileSync(join(root, name), join(dir, name));
    fs.symlinkSync(
      join(root, 'node_modules'),
      join(dir, 'node_modules'),
      'dir',
    );
    fs.mkdirSync(join(dir, 'dist'));
    fs.writeFileSync(join(dir, 'dist/manifest.json'), 'installed-manifest');
    fs.writeFileSync(join(dir, 'dist/keep'), 'runtime-marker');
    execFileSync(process.execPath, ['esbuild.config.mjs'], {
      cwd: dir,
      stdio: 'pipe',
    });
    assert.equal(
      fs.readFileSync(join(dir, 'dist/manifest.json'), 'utf8'),
      'installed-manifest',
    );
    assert.equal(
      fs.readFileSync(join(dir, 'dist/keep'), 'utf8'),
      'runtime-marker',
    );
    assert.ok(fs.existsSync(join(dir, '.build/extension/content.js')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function prepared(dir) {
  const candidate = join(dir, 'candidate'),
    installed = join(dir, 'installed'),
    backup = join(dir, 'backup');
  fs.mkdirSync(candidate);
  fs.mkdirSync(installed);
  for (const name of FILES) {
    const target = join(candidate, name);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, 'synthetic candidate ' + name);
  }
  const m = JSON.parse(fs.readFileSync(join(root, 'manifest.json')));
  m.version = '0.2.1';
  fs.writeFileSync(join(candidate, 'manifest.json'), JSON.stringify(m));
  const old = { ...m, version: '0.2.0' };
  fs.writeFileSync(join(installed, 'manifest.json'), JSON.stringify(old));
  fs.writeFileSync(join(installed, 'background.js'), 'previous-runtime');
  fs.writeFileSync(join(installed, 'keep'), 'untouched');
  return { candidate, installed, backup };
}
test('deployment preserves directory identity and backs up the previous runtime', async () => {
  const { deployExtension } = await import('../scripts/deploy.mjs');
  const dir = fixture();
  try {
    const p = prepared(dir),
      inode = fs.statSync(p.installed).ino;
    deployExtension(p.candidate, p.installed, p.backup, '0.2.1');
    assert.equal(fs.statSync(p.installed).ino, inode);
    assert.equal(
      fs.readFileSync(join(p.installed, 'keep'), 'utf8'),
      'untouched',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(join(p.installed, 'manifest.json'))).version,
      '0.2.1',
    );
    assert.equal(
      fs.readFileSync(join(p.backup, 'background.js'), 'utf8'),
      'previous-runtime',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('incomplete or wrong-ID candidates fail before touching installed files', async () => {
  const { deployExtension } = await import('../scripts/deploy.mjs');
  const dir = fixture();
  try {
    const p = prepared(dir),
      old = fs.readFileSync(join(p.installed, 'manifest.json'), 'utf8');
    fs.unlinkSync(join(p.candidate, 'options.js'));
    assert.throws(() =>
      deployExtension(p.candidate, p.installed, p.backup, '0.2.1'),
    );
    assert.equal(
      fs.readFileSync(join(p.installed, 'manifest.json'), 'utf8'),
      old,
    );
    assert.equal(
      fs.readFileSync(join(p.installed, 'background.js'), 'utf8'),
      'previous-runtime',
    );
    assert.equal(fs.existsSync(p.backup), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment refuses symlinked target parents before writing outside runtime', async () => {
  const { deployExtension } = await import('../scripts/deploy.mjs');
  const dir = fixture();
  try {
    const p = prepared(dir),
      external = join(dir, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(join(external, 'icon-16.png'), 'outside-original');
    fs.symlinkSync(external, join(p.installed, 'icons'), 'dir');
    assert.throws(() =>
      deployExtension(p.candidate, p.installed, p.backup, '0.2.1'),
    );
    assert.equal(
      fs.readFileSync(join(external, 'icon-16.png'), 'utf8'),
      'outside-original',
    );
    assert.equal(
      fs.readFileSync(join(p.installed, 'background.js'), 'utf8'),
      'previous-runtime',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test(
  'a mid-publication error restores prior runtime bytes and manifest',
  {
    skip:
      process.platform === 'win32' ||
      (process.getuid && process.getuid() === 0),
  },
  async () => {
    const { deployExtension } = await import('../scripts/deploy.mjs');
    const dir = fixture();
    let p;
    try {
      p = prepared(dir);
      fs.mkdirSync(join(p.installed, 'icons'));
      fs.chmodSync(join(p.installed, 'icons'), 0o500);
      const manifest = fs.readFileSync(
        join(p.installed, 'manifest.json'),
        'utf8',
      );
      assert.throws(() =>
        deployExtension(p.candidate, p.installed, p.backup, '0.2.1'),
      );
      assert.equal(
        fs.readFileSync(join(p.installed, 'background.js'), 'utf8'),
        'previous-runtime',
      );
      assert.equal(
        fs.readFileSync(join(p.installed, 'manifest.json'), 'utf8'),
        manifest,
      );
    } finally {
      if (p)
        for (const x of [join(p.installed, 'icons'), join(p.backup, 'icons')])
          if (fs.existsSync(x)) fs.chmodSync(x, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('manifest/package version mismatch is rejected before publication', async () => {
  const { deployExtension } = await import('../scripts/deploy.mjs');
  const dir = fixture();
  try {
    const p = prepared(dir);
    assert.throws(() =>
      deployExtension(p.candidate, p.installed, p.backup, '0.9.0'),
    );
    assert.equal(
      fs.readFileSync(join(p.installed, 'background.js'), 'utf8'),
      'previous-runtime',
    );
    assert.equal(fs.existsSync(p.backup), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
