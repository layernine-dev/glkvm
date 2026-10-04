const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const config = require('../release.json');
const hash = (/** @type {Buffer} */ value) => createHash('sha256').update(value).digest('hex');

/** Exercise the real publisher against a synthetic GitHub/CLI boundary. No uploads.
 * @param {import('node:test').TestContext} t @param {boolean} [updatesEnabled] */
function fixture(t, updatesEnabled = config.updatesEnabled) {
  const releaseConfig = { ...config, updatesEnabled };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-publish-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'dist/release');
  fs.mkdirSync(output, { recursive: true });
  const sha = '1'.repeat(40), archive = 'GLKVM-Clean-0.1.22-darwin-arm64.zip';
  const bytes = Buffer.from('synthetic signed/notarized artifact');
  fs.writeFileSync(path.join(output, archive), bytes);
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${hash(bytes)}  ${archive}\n`);
  const info = { sha, version: '0.1.22', tag: 'v0.1.22', repository: config.repository, updatesEnabled, archive, sha256: hash(bytes), electron: '44.5.1' };
  fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify(info));
  /** @type {any} */
  const state = { release: null, uploads: 0, publishes: 0, private: false, corruptDigest: false, tagSha: null, moveTagOnUpload: false };
  /** @param {string} command @param {string[]} args @param {{input?: string}} options */
  function spawnSync(command, args, options) {
    /** @type {any} */
    let result;
    if (command === 'git') result = args[0] === 'rev-parse' ? sha : `${sha}\n${config.baseCommit}`;
    else if (args[0] === 'release' && args[1] === 'upload') {
      assert.equal(state.release.draft, true, 'Only drafts may receive asset uploads');
      state.uploads++;
      if (state.moveTagOnUpload) state.tagSha = '2'.repeat(40);
      state.release.assets = [archive, 'SHA256SUMS', 'release.json'].map(name => ({ name, size: fs.statSync(path.join(output, name)).size, digest: `sha256:${state.corruptDigest ? '0'.repeat(64) : hash(fs.readFileSync(path.join(output, name)))}` }));
      result = '';
    } else if (args[0] === 'release' && args[1] === 'download') result = fs.readFileSync(path.join(output, 'release.json'), 'utf8');
    else if (args[0] === 'api') {
      const endpoint = args[1], body = options.input ? JSON.parse(options.input) : null;
      if (endpoint === `repos/${config.repository}`) result = { private: state.private };
      else if (endpoint.includes('/git/matching-refs/')) result = state.tagSha ? [{ ref: 'refs/tags/v0.1.22' }] : [];
      else if (endpoint.endsWith('/git/refs')) { state.tagSha = body.sha; result = { ref: body.ref }; }
      else if (endpoint.includes('/releases?')) result = [state.release ? [state.release] : []];
      else if (endpoint.endsWith('/releases')) {
        state.release = { ...body, id: 123, assets: [], html_url: 'https://example.invalid/release' };
        result = state.release;
      } else if (endpoint.endsWith('/releases/123')) {
        if (body) { state.publishes++; Object.assign(state.release, body); }
        result = state.release;
      } else if (endpoint.includes('/commits/')) result = { sha: state.tagSha };
      else throw new Error(`Unexpected endpoint: ${endpoint}`);
    } else throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    return { status: 0, stdout: typeof result === 'string' ? result : JSON.stringify(result), stderr: '' };
  }
  const loaded = { exports: /** @type {any} */ ({}) };
  const source = fs.readFileSync(path.join(__dirname, '../scripts/release.cjs'), 'utf8');
  vm.runInNewContext(source, {
    module: loaded, __dirname: path.join(directory, 'scripts'), process, console: { log() {} },
    require: (/** @type {string} */ name) => {
      if (name === 'node:child_process') return { spawnSync };
      if (name === '../release.json') return releaseConfig;
      if (name.startsWith('./')) return {};
      return require(name);
    },
  });
  return { state, publisher: loaded.exports, output, archive };
}

test('publishing verifies draft assets before going live and retries keep published assets', t => {
  const { state, publisher } = fixture(t);
  assert.equal(publisher.alreadyPublished(), false);
  publisher.publishRelease();
  assert.equal(state.release.draft, false);
  assert.equal(state.publishes, 1);
  assert.equal(publisher.alreadyPublished(), true);
  publisher.publishRelease();
  assert.equal(state.uploads, 1);
  assert.equal(state.publishes, 1);
});

test('bad uploaded digests leave the release unpublished', t => {
  const { state, publisher } = fixture(t);
  state.corruptDigest = true;
  assert.throws(() => publisher.publishRelease(), /Uploaded asset did not verify/);
  assert.equal(state.release.draft, true);
  assert.equal(state.publishes, 0);
});

test('public repositories publish updater-enabled releases', t => {
  const { state, publisher } = fixture(t);
  state.private = false;
  publisher.publishRelease();
  assert.equal(state.release.draft, false);
  assert.equal(state.publishes, 1);
  assert.equal(publisher.alreadyPublished(), true);
});

test('a private repository cannot receive releases or pass the retry check', t => {
  const { state, publisher } = fixture(t);
  state.private = true;
  assert.throws(() => publisher.publishRelease(), /require a public repository/);
  assert.throws(() => publisher.alreadyPublished(), /require a public repository/);
  assert.equal(state.release, null);
  assert.equal(state.tagSha, null);
  assert.equal(state.uploads, 0);
});

test('a conflicting tag without a release fails before creating a draft', t => {
  const { state, publisher } = fixture(t);
  state.tagSha = '2'.repeat(40);
  assert.throws(() => publisher.publishRelease(), /tag belongs to a different source commit/);
  assert.equal(state.release, null);
  assert.equal(state.uploads, 0);
  assert.equal(state.publishes, 0);
});

test('a tag changed during upload leaves the draft unpublished', t => {
  const { state, publisher } = fixture(t);
  state.moveTagOnUpload = true;
  assert.throws(() => publisher.publishRelease(), /tag changed before publication/);
  assert.equal(state.release.draft, true);
  assert.equal(state.publishes, 0);
});

test('modified artifacts cannot publish', t => {
  const { state, publisher, output, archive } = fixture(t);
  fs.writeFileSync(path.join(output, archive), 'changed');
  assert.throws(() => publisher.publishRelease(), /checksum mismatch/);
  assert.equal(state.uploads, 0);
});

test('release metadata cannot disagree with the packaged updater setting', t => {
  const { state, publisher, output } = fixture(t, false);
  const file = path.join(output, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.updatesEnabled = true;
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => publisher.publishRelease(), /manifest does not match/);
  assert.equal(state.release, null);
  assert.equal(state.uploads, 0);
});

test('an existing tag for a different source is never reused', t => {
  const { state, publisher } = fixture(t);
  state.release = { tag_name: 'v0.1.22', body: 'Source commit: another', draft: false };
  assert.throws(() => publisher.alreadyPublished(), /different commit/);
  assert.throws(() => publisher.publishRelease(), /different source commit/);
  assert.equal(state.uploads, 0);
});
