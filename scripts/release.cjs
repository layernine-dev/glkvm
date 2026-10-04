const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveSigningIdentity } = require('./signing-identity.cjs');
const { verifySignature } = require('./verify-signature.cjs');
const { verifyLicenses } = require('./licenses.cjs');
const config = require('../release.json');
const root = path.join(__dirname, '..');
const output = path.join(root, 'dist/release');

/** @param {string} command @param {string[]} args @param {string} [input] */
function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Every first-parent main commit gets a deterministic, increasing patch version.
 * No version commits, races between PRs, or counter changes on workflow retries.
 * @param {string} base @param {number} distance
 */
function versionAt(base, distance) {
  if (!/^\d+\.\d+\.\d+$/.test(base) || !Number.isSafeInteger(distance) || distance < 0) throw new Error('Invalid release version base/distance.');
  const [major, minor, patch] = base.split('.').map(Number);
  if (!Number.isSafeInteger(patch + distance)) throw new Error('Release version overflow.');
  return `${major}.${minor}.${patch + distance}`;
}
function releaseInfo() {
  const sha = run('git', ['rev-parse', 'HEAD']);
  const history = run('git', ['rev-list', '--first-parent', 'HEAD']).split('\n');
  const distance = history.indexOf(config.baseCommit);
  if (distance < 0) throw new Error('Release base is missing from first-parent history; fetch full history.');
  const version = versionAt(config.baseVersion, distance);
  return { sha, version, tag: `v${version}`, repository: config.repository };
}

function checkRelease() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Release builds require Apple Silicon macOS.');
  const identity = resolveSigningIdentity('release');
  const profile = process.env.GLKVM_NOTARY_PROFILE;
  if (!profile) throw new Error('Set GLKVM_NOTARY_PROFILE to an existing notarytool Keychain profile. See docs/releases.md.');
  // Read-only authentication check: no certificate exports or ACL changes.
  run('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json']);
  console.log(`Developer ID and notarytool credentials verified (${identity}).`);
  return { identity, profile };
}

async function buildRelease() {
  const { identity, profile } = checkRelease();
  const info = releaseInfo();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== info.sha) throw new Error('Checkout does not match the triggering commit.');
  if (run('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Release builds require a clean checkout.');
  fs.mkdirSync(output, { recursive: true });
  const { buildApp } = require('./build.cjs');
  const appPath = await buildApp({ release: true, appVersion: info.version });
  const archive = path.join(output, `GLKVM-Clean-${info.version}-darwin-arm64.zip`);
  if (fs.existsSync(archive)) fs.unlinkSync(archive);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive]);
  const result = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', archive, '--keychain-profile', profile, '--wait', '--output-format', 'json']));
  if (result.status !== 'Accepted') throw new Error(`Notarization ${result.id || ''} was not accepted: ${result.status}`);
  run('/usr/bin/xcrun', ['stapler', 'staple', appPath]);
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
  verifySignature(appPath, identity, true);
  verifyLicenses(appPath);
  fs.unlinkSync(archive);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive]);
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${sha256}  ${path.basename(archive)}\n`);
  fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify({ ...info, archive: path.basename(archive), sha256, notarizationId: result.id, electron: require('electron/package.json').version }, null, 2) + '\n');
  console.log(`Notarized release ${info.tag}: ${archive}`);
}

/** @param {string} endpoint @param {object} [body] */
function api(endpoint, body) {
  return JSON.parse(run('gh', ['api', endpoint, ...(body ? ['--method', 'POST', '--input', '-'] : [])], body ? JSON.stringify(body) : undefined));
}
function publishRelease() {
  const info = JSON.parse(fs.readFileSync(path.join(output, 'release.json'), 'utf8'));
  const expected = releaseInfo();
  if (info.sha !== expected.sha || info.tag !== expected.tag || info.repository !== config.repository) throw new Error('Release manifest does not match this checkout.');
  const archive = path.join(output, info.archive);
  if (path.dirname(archive) !== output || createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== info.sha256) throw new Error('Release archive checksum mismatch.');
  const repo = `repos/${config.repository}`;
  const metadata = api(repo);
  if (metadata.private) throw new Error('Public updates require a public GitHub repository. No release was published.');
  // Fetch all releases so retries can find an older draft without changing it.
  const releases = JSON.parse(run('gh', ['api', `${repo}/releases?per_page=100`, '--paginate', '--slurp'])).flat();
  let release = releases.find((/** @type {any} */ item) => item.tag_name === info.tag);
  const marker = `Source commit: ${info.sha}`;
  if (release && !release.body?.includes(marker)) throw new Error('Existing release belongs to a different source commit.');
  if (!release) release = api(`${repo}/releases`, {
    tag_name: info.tag, target_commitish: info.sha, name: `GLKVM Clean ${info.version}`, draft: true, prerelease: false,
    body: `${marker}\n\nApple Silicon, latest macOS. Download the ZIP, extract it and move GLKVM Clean.app to /Applications.\n\nChanges: https://github.com/${config.repository}/commit/${info.sha}\n\nElectron ${info.electron}. Signed with Developer ID and notarized by Apple. Full third-party notices are included in the app (Open Source Licenses menu).`,
  });
  const files = [info.archive, 'SHA256SUMS', 'release.json'];
  if (release.draft) {
    // Replacing incomplete draft assets is safe; published assets are immutable.
    run('gh', ['release', 'upload', info.tag, ...files.map(file => path.join(output, file)), '--repo', config.repository, '--clobber']);
  }
  const readback = api(`${repo}/releases/${release.id}`);
  for (const file of files) {
    const asset = readback.assets.find((/** @type {any} */ item) => item.name === file);
    const expectedDigest = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}`;
    if (!asset || asset.size !== fs.statSync(path.join(output, file)).size || asset.digest !== expectedDigest) throw new Error(`Uploaded asset did not verify: ${file}`);
  }
  if (readback.draft) {
    const newer = releases.some((/** @type {any} */ item) => !item.draft && /^v\d+\.\d+\.\d+$/.test(item.tag_name) && compareVersions(item.tag_name.slice(1), info.version) > 0);
    run('gh', ['api', `${repo}/releases/${release.id}`, '--method', 'PATCH', '--input', '-'], JSON.stringify({ draft: false, make_latest: newer ? 'false' : 'true' }));
  }
  const published = api(`${repo}/releases/${release.id}`);
  if (published.draft || published.prerelease || api(`${repo}/commits/${info.tag}`).sha !== info.sha) throw new Error('Published release/tag verification failed.');
  console.log(`Verified public release: ${published.html_url}`);
}
/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function alreadyPublished() {
  const info = releaseInfo();
  const releases = JSON.parse(run('gh', ['api', `repos/${config.repository}/releases?per_page=100`, '--paginate', '--slurp'])).flat();
  const release = releases.find((/** @type {any} */ item) => item.tag_name === info.tag && !item.draft);
  if (!release) return false;
  if (release.prerelease || !release.body?.includes(`Source commit: ${info.sha}`) || api(`repos/${config.repository}/commits/${info.tag}`).sha !== info.sha) throw new Error('Published version belongs to a different commit.');
  const stored = JSON.parse(run('gh', ['release', 'download', info.tag, '--repo', config.repository, '--pattern', 'release.json', '--output', '-']));
  const zip = release.assets.find((/** @type {any} */ asset) => asset.name === stored.archive);
  if (stored.sha !== info.sha || stored.version !== info.version || !zip || zip.digest !== `sha256:${stored.sha256}`) throw new Error('Published release assets did not verify.');
  console.log(`Release ${info.tag} already published and verified; keeping original assets.`);
  return true;
}
module.exports = { versionAt, releaseInfo, compareVersions, publishRelease, alreadyPublished };
if (require.main === module) {
  void (async () => {
    switch (process.argv[2]) {
      case 'check': checkRelease(); break;
      case 'build': await buildRelease(); break;
      case 'publish': publishRelease(); break;
      case 'info': console.log(JSON.stringify(releaseInfo())); break;
      case 'published': process.exitCode = alreadyPublished() ? 0 : 2; break;
      default: throw new Error('Usage: release.cjs check|build|publish|info|published');
    }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
