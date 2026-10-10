const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { plainReleaseNotes } = require('../src/release-notes.cjs');

test('release notes include skipped releases and ignore unrelated branch tags', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-changelog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Changelog Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['commit', '--allow-empty', '-qm', 'Initial audio routing']);
  const baseCommit = git(['rev-parse', 'HEAD']);
  git(['tag', 'v0.1.21']);
  git(['switch', '-qc', 'unrelated']);
  git(['commit', '--allow-empty', '-qm', 'Unreleased branch experiment']);
  git(['tag', 'v9.0.0']);
  git(['switch', '-q', 'main']);
  git(['commit', '--allow-empty', '-qm', 'Fix focus preservation']);
  git(['commit', '--allow-empty', '-qm', 'Allow display sleep (#1)']);
  const sha = git(['rev-parse', 'HEAD']);
  git(['tag', 'v0.1.23']);
  const loaded = { exports: /** @type {any} */ ({}) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/changelog.cjs'), 'utf8'), {
    module: loaded, __dirname: path.join(directory, 'scripts'),
    require: (/** @type {string} */ name) => {
      if (name === '../release.json') return { baseCommit, repository: 'layernine-dev/glkvm' };
      if (name === 'node:child_process') return { execFileSync: (/** @type {string} */ command, /** @type {string[]} */ args) => execFileSync(command, args, { cwd: directory, encoding: 'utf8' }) };
      return require(name);
    },
  });
  const notes = loaded.exports.releaseNotes({ sha, tag: 'v0.1.23', repository: 'layernine-dev/glkvm' });
  assert.match(notes, /Fix focus preservation/);
  assert.match(notes, /Allow display sleep/);
  assert.match(notes, /compare\/v0\.1\.21\.\.\.v0\.1\.23/);
  assert.doesNotMatch(notes, /Unreleased branch experiment/);
  const changelog = loaded.exports.changelog(sha, '0.1.23');
  assert.equal((changelog.match(/## 0\.1\.23/g) || []).length, 1);
  assert.doesNotMatch(changelog, /9\.0\.0/);
});

test('native update notes show changes without installation metadata or active markup', () => {
  const notes = plainReleaseNotes("Source commit: abc\n\n## What's changed\n\n- **Fix focus** in `viewer`\n- [Audio routing](https://example.invalid)\n\n[Full changelog](https://example.invalid)\n\n## Installation\n\nDownload a ZIP");
  assert.match(notes, /Fix focus in viewer/);
  assert.match(notes, /Audio routing/);
  assert.doesNotMatch(notes, /Source commit|Download|https:|\*\*|`/);
  assert.equal(plainReleaseNotes(undefined), '');
  assert.equal(plainReleaseNotes('<b>Legacy notes</b>'), 'Legacy notes');
  assert.equal(plainReleaseNotes('x'.repeat(20000)).length, 16000);
});
