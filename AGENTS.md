# Dependency policy

- Use the latest stable dependency releases that have completed the one-day
  supply chain cooldown configured in `bunfig.toml`, including major updates.
- Dependency upgrades belong in dedicated PRs, normally opened by the dependency
  workflow. Run `bun run deps:update`, review relevant release notes, and validate
  dependency changes with all project checks. Ordinary feature/fix PRs use the
  committed lockfile; do not bundle unrelated upgrades.
- Do not bypass the cooldown, exempt packages, or select prerelease versions
  without explicit user authorization. Keep semver ranges and the lockfile.
- Do not extend the cooldown beyond 24 hours. Bun may extend its age filter
  when it detects rapid releases; if that holds an eligible latest release back,
  request that exact version through Bun's age gate, then retain a semver range.

# macOS execution identity

- Start the app and GUI tests only through the signed GLKVM bundle with
  `dev.layernine.glkvm-clean`. Local development and GUI tests use the developer's
  own stable Apple Development identity; official releases use the project's
  Developer ID Application identity. Never distribute a maintainer's private key.
  Use `bun start` and `bun run test:gui`; never launch generic `electron .` or
  `electron test/...` against user credentials or macOS privacy resources.
- GUI fixtures use temporary profiles and local storage adapters. Verify real
  Keychain integration only in the signed product app. Do not change Keychain
  access controls, delete keys, or ask the user to authorize generic Electron
  as a workaround for an incorrect test runtime.

# Collaboration and releases

- Read CONTRIBUTING.md for setup and checks. Use `bun run test` for unit tests.
- Support Apple Silicon on the latest stable macOS. Do not add Intel builds.
- Preserve the product bundle ID in GUI tests, temporary test profiles, helper
  identifiers and executable UUID derivation. Tests must never enable the updater.
- Every merge to main is a release after successful CI. CI assigns the version;
  do not bump package.json in ordinary PRs or introduce prerelease channels.
- CI runs trusted repository pushes on neo under its shared test lock, with at
  most two compiler jobs. Do not add untrusted fork execution on that runner.
- Keep release credentials out of Git. Preserve third-party license texts in
  distributed bundles; run `bun run licenses:check` after building.
