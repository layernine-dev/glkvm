# Dependency policy

- Use the latest stable dependency releases that have completed the seven-day
  supply chain cooldown configured in `bunfig.toml`, including major updates.
- Before shipping runtime changes, run `bun run deps:update`, review relevant
  release notes, and validate any dependency changes with the project checks.
- Do not bypass the cooldown, exempt packages, or select prerelease versions
  without explicit user authorization. Keep semver ranges and the lockfile.
