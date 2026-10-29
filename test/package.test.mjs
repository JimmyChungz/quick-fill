import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FILES,
  extensionId,
  validateEntries,
  validateManifest,
} from '../scripts/package.mjs';
test('preserves fixed extension ID and rejects metadata drift', () => {
  const m = JSON.parse(
    readFileSync(new URL('../manifest.json', import.meta.url)),
  );
  assert.equal(extensionId(m.key), 'neilinbkkjgcnflgamepebchiapfcibm');
  const version = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url)),
  ).version;
  validateManifest(m, version);
  assert.throws(() => validateManifest({ ...m, version: '0.1.0' }, version));
  for (const patterns of [['<all_urls>'],['file:///*'],['http://*/*','https://*/*','ftp://*/*']]) {
    assert.throws(() => validateManifest({...m,host_permissions:patterns},version));
    assert.throws(() => validateManifest({...m,content_scripts:[{...m.content_scripts[0],matches:patterns}]},version));
  }
  assert.throws(() => validateManifest({ ...m, web_accessible_resources: [{resources: ['*'], matches: ['<all_urls>']}] }, version));
  assert.throws(() =>
    validateManifest({ ...m, permissions: ['storage', 'tabs'] }, version),
  );
});
test('package excludes source maps, tests, credentials and dependencies', () => {
  validateEntries(FILES);
  for (const n of ['content.js.map', 'qf-test.html', '.env', 'node_modules/x'])
    assert.throws(() => validateEntries([...FILES, n]));
  assert.throws(() => validateEntries(FILES.slice(1)));
});
