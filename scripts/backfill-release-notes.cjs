// Update release descriptions only. Published tags, ZIPs and digests stay intact.
const { execFileSync } = require('node:child_process');
const { releaseNotes } = require('./changelog.cjs');
const { repository } = require('../release.json');
/** @param {string[]} args @param {unknown} [input] */
function gh(args, input) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input) }));
}
const apply = process.argv.includes('--apply');
const latest = gh(['api', `repos/${repository}/releases/latest`]);
const releases = gh(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp']).flat();
for (const release of releases) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || release.body?.includes("## What's changed")) continue;
  const historical = /Sanitized source history: https:\/\/github\.com\/[^\s]+\/commit\/([a-f0-9]{40})/.exec(release.body || '');
  const sha = /^Source commit: ([a-f0-9]{40})$/m.exec(release.body || '')?.[1] || historical?.[1];
  if (!sha) throw new Error(`Missing source marker: ${release.tag_name}`);
  const commit = gh(['api', `repos/${repository}/commits/${release.tag_name}`]);
  if (commit.sha !== sha) throw new Error(`Release tag/source mismatch: ${release.tag_name}`);
  const notes = releaseNotes({ sha, tag: release.tag_name, repository }) + (historical ? '\n\nThese notes describe the sanitized historical source snapshot. The original binary predates that snapshot; see the provenance below.' : '');
  const body = historical ? `${notes}\n\n${release.body}` : release.body.replace(`Source commit: ${sha}`, `Source commit: ${sha}\n\n${notes}`);
  if (!apply) { console.log(`${release.tag_name}\n${notes}\n`); continue; }
  gh(['api', `repos/${repository}/releases/${release.id}`, '--method', 'PATCH', '--input', '-'], { body, make_latest: release.id === latest.id ? 'true' : 'false' });
  const readback = gh(['api', `repos/${repository}/releases/${release.id}`]);
  if (readback.body !== body || JSON.stringify(readback.assets.map((/** @type {any} */ asset) => [asset.id, asset.digest, asset.size])) !== JSON.stringify(release.assets.map((/** @type {any} */ asset) => [asset.id, asset.digest, asset.size]))) {
    throw new Error(`Release description/assets did not verify: ${release.tag_name}`);
  }
  console.log(`Verified release notes: ${release.html_url}`);
}

if (apply && gh(['api', `repos/${repository}/releases/latest`]).id !== latest.id) throw new Error('The latest release changed during backfill; recheck publication state.');
