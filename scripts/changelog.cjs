const { execFileSync } = require('node:child_process');
const config = require('../release.json');

/** @param {string[]} args */
function git(args) { return execFileSync('git', args, { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' }).trim(); }
/** @param {string} sha */
function history(sha) { return git(['rev-list', '--first-parent', sha]).split('\n'); }
function releaseTags() {
  return git(['tag', '--list', 'v*']).split('\n').filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
    .map(tag => ({ tag, sha: git(['rev-parse', `${tag}^{commit}`]) }));
}
/** Use only releases on this commit's first-parent history, including across skipped releases.
 * @param {string} sha */
function changesFor(sha) {
  const commits = history(sha);
  const previous = releaseTags().map(item => ({ ...item, index: commits.indexOf(item.sha) }))
    .filter(item => item.index > 0).sort((a, b) => a.index - b.index)[0];
  const base = previous?.sha || (sha !== config.baseCommit && commits.includes(config.baseCommit) ? config.baseCommit : null);
  const range = base ? `${base}..${sha}` : sha;
  const changes = git(['log', '--first-parent', '--reverse', '--format=%H', range]).split('\n').filter(Boolean).map(commit => {
    const message = git(['show', '-s', '--format=%B', commit]);
    const lines = message.split('\n');
    const title = /^Merge pull request #\d+/.test(lines[0]) ? lines.find((line, i) => i > 0 && line.trim()) || lines[0] : lines[0];
    return `- ${title.replace(/[\x00-\x1f\x7f]/g, '').trim()}`;
  });
  return { changes: [...new Set(changes)].join('\n'), previous: previous?.tag || null };
}
/** @param {{sha: string, tag: string, repository: string}} info */
function releaseNotes(info) {
  const { changes, previous } = changesFor(info.sha);
  const url = `https://github.com/${info.repository}`;
  return `## What's changed\n\n${changes}\n\n[Full changelog](${url}/${previous ? `compare/${previous}...${info.tag}` : `commits/${info.sha}`})`;
}
/** @param {string} sha @param {string} version */
function changelog(sha, version) {
  const commits = history(sha);
  const releases = releaseTags().filter(item => commits.includes(item.sha) && item.sha !== sha)
    .concat([{ sha, tag: version === 'Unreleased' ? 'HEAD' : `v${version}` }]).sort((a, b) => commits.indexOf(a.sha) - commits.indexOf(b.sha));
  return '# GLKVM Clean changelog\n\nGenerated from release tags and commit history. See each GitHub release for historical binary provenance.\n\n' + releases.map(item => {
    const date = git(['show', '-s', '--format=%cs', item.sha]);
    return `## ${item.tag === 'HEAD' ? 'Unreleased' : item.tag.slice(1)} (${date})\n\n${releaseNotes({ ...item, repository: config.repository }).replace("## What's changed\n\n", '')}`;
  }).join('\n\n') + '\n';
}
module.exports = { changesFor, releaseNotes, changelog };
if (require.main === module) process.stdout.write(changelog(git(['rev-parse', 'HEAD']), process.argv[2] || require('../package.json').version));
