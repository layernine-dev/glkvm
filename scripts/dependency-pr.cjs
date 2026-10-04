// Runs only in the dependency workflow. Resolution is always performed by Bun,
// using bunfig.toml; this script never selects versions or weakens the age gate.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}
try {
  if (process.env.GITHUB_REPOSITORY !== 'layernine-dev/glkvm' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Dependency PRs must be created from the upstream main branch.');
  if (!run('git', ['diff', '--name-only', '--', 'package.json', 'bun.lock'])) process.exit(0);
  const branch = 'automation/dependencies';
  const previous = run('git', ['ls-remote', '--heads', 'origin', branch]).split(/\s/)[0];
  if (previous) {
    run('git', ['fetch', 'origin', branch]);
    const same = ['package.json', 'bun.lock'].every(file => {
      const old = run('git', ['show', `FETCH_HEAD:${file}`]);
      return old === fs.readFileSync(file, 'utf8').trim();
    });
    if (same) { console.log('The dependency PR already contains these versions.'); process.exit(0); }
  }
  run('git', ['switch', '-c', branch]);
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['add', 'package.json', 'bun.lock']);
  run('git', ['commit', '-m', 'Update dependencies after the 24-hour cooldown']);
  // This branch is automation-owned. The explicit lease protects a concurrent
  // maintainer edit between inspection and push.
  run('git', ['push', `--force-with-lease=refs/heads/${branch}:${previous}`, 'origin', `HEAD:refs/heads/${branch}`]);
  const prs = JSON.parse(run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']));
  if (!prs.length) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-deps-'));
    try {
      const body = path.join(directory, 'body.md');
      fs.writeFileSync(body, 'Updates direct and transitive dependencies, including major versions, through Bun’s configured 24-hour release cooldown.\n\nReview upstream release notes and the dependency diff before merging. The dispatched macOS checks cover type checking, unit tests and signed GUI fixtures on the macOS runner. Electron/Chromium changes also require reviewing the device-ID mapping in src/device-ids.cjs.\n\nMerging this PR publishes a new release after CI succeeds.\n');
      run('gh', ['pr', 'create', '--head', branch, '--base', 'main', '--title', 'Update dependencies after the 24-hour cooldown', '--body-file', body]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  // GITHUB_TOKEN pushes don't trigger push workflows; dispatch CI explicitly.
  run('gh', ['workflow', 'run', 'macos.yml', '--ref', branch]);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
