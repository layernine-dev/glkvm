# Dependency policy

- Use the latest stable dependency releases that have completed the one-day
  supply chain cooldown configured in `bunfig.toml`, including major updates.
- Before shipping runtime changes, run `bun run deps:update`, review relevant
  release notes, and validate any dependency changes with the project checks.
- Do not bypass the cooldown, exempt packages, or select prerelease versions
  without explicit user authorization. Keep semver ranges and the lockfile.
- Do not extend the cooldown beyond 24 hours. Bun may extend its age filter
  when it detects rapid releases; if that holds an eligible latest release back,
  request that exact version through Bun's age gate, then retain a semver range.

# macOS execution identity

- Start the app and GUI tests only through the signed GLKVM bundle with
  `dev.layernine.glkvm-clean` and the existing Apple Development identity.
  Use `bun start` and `bun run test:gui`; never launch generic `electron .` or
  `electron test/...` against user credentials or macOS privacy resources.
- GUI fixtures use temporary profiles and local storage adapters. Verify real
  Keychain integration only in the signed product app. Do not change Keychain
  access controls, delete keys, or ask the user to authorize generic Electron
  as a workaround for an incorrect test runtime.
