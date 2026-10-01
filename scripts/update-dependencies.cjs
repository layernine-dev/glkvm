const { spawnSync } = require('node:child_process');
const { packageManager } = require('../package.json');
const minimum = packageManager.replace(/^bun@/, '').split('.').map(Number);
const current = process.versions.bun?.split('.').map(Number);
if (!current || current.some(value => !Number.isInteger(value)) ||
    current[0] < minimum[0] ||
    (current[0] === minimum[0] && current[1] < minimum[1]) ||
    (current[0] === minimum[0] && current[1] === minimum[1] && current[2] < minimum[2])) {
  console.error(`Dependency updates require ${packageManager} or newer to enforce the release cooldown.`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ['update', '--latest'], { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
