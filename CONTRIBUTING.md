# Contributing to GLKVM Clean

GLKVM Clean is an independent MIT-licensed project, not an official GL.iNet app.
Contributions are accepted under the project's [MIT license](LICENSE).

## Development environment

Use an Apple Silicon Mac running the latest stable macOS, Xcode with its command
line tools selected, Node.js 22.12 or newer, Git, and the Bun version declared in
`package.json` (or newer). The supported app architecture is arm64 only.

For `bun start`, builds and GUI tests, create or use your own **Apple Development**
certificate and private key in your login Keychain. Never request or distribute
another developer's private key. List available identities with:

```sh
security find-identity -v -p codesigning
```

If more than one development identity is available, select yours locally:

```sh
export GLKVM_SIGNING_IDENTITY='Apple Development: Your Name (YOURTEAMID)'
bun install --frozen-lockfile
bun start
```

Keep using that identity on your Mac. App and test bundles both use
`dev.layernine.glkvm-clean`, with stable helper IDs and app-specific executable
UUIDs. Temporary test profiles isolate data; the fixture password adapter never
accesses your Keychain. macOS can still ask for consent on a new Mac or after a
signer change. Do not change Keychain ACLs or use generic Electron to avoid prompts.

## Checks

```sh
bun run check
bun run test
bun run test:gui
bun run build
bun run licenses:check
```

`check` and `test` do not need a signing identity. `test:gui` builds one signed
fixture bundle, then starts each scenario in a separate process. It uses local
HTTP fixtures and fake audio devices. `test:devices` is an optional, read-only
integration check using the Mac's real device catalog. Actual KVM hardware,
firmware behavior and Keychain integration need separate product-app checks.

Run builds and GUI tests sequentially on a Mac. On neo, all builds and tests use:

```sh
python3 "$HOME/dev/my/macos/scripts/neo-test-lock.py" /bin/zsh -lc \
  'export CMAKE_BUILD_PARALLEL_LEVEL=2; bun run check && bun run test && bun run test:gui'
```

The personal fleet wrapper is specific to neo; another developer can use the
ordinary commands on their own Mac. Compiler parallelism is capped at two jobs.

## Pull requests and releases

- Create a branch, make a focused change, and open a PR against `main`.
- Trusted collaborators' pushes run the macOS checks on neo. The same SHA's
  push checks appear on its PR; there is no duplicate `pull_request` execution.
- Forks do not execute on the maintainers' personal runner. A maintainer reviews
  a contribution before importing it to a trusted branch for these tests.
- Do not bump `package.json` for each PR. CI derives a deterministic patch
  version from main's first-parent history; every merge, including documentation
  and dependency PRs, becomes a release after successful CI.
- Do not force-push main or rewrite the release base in `release.json`.
- Official signing/notarization credentials are needed only on the release
  runner. Releases stay in this private repository. Automatic app updates are
  disabled in every build until a suitable distribution service is chosen.

See [release operations](docs/releases.md) for provisioning and recovery.

## Dependencies

The daily dependency workflow runs in GitHub's Linux cloud runner and opens or
updates `automation/dependencies`. It uses `bun run deps:update` with the existing
24-hour cooldown, including stable major updates, and explicitly dispatches the
same macOS checks. It does not auto-merge. Review upstream release notes and the
lockfile before merging. Ordinary feature/fix PRs use the committed lockfile.

For a manual dependency upgrade, run `bun run deps:update` and all checks above.
Never disable the cooldown or add package exemptions. New shipped dependencies
need their license texts. Missing license text fails packaging. The reviewed
version-specific exception is documented in [third-party provenance](docs/provenance.md).

Electron upgrades also require reviewing `src/device-ids.cjs`: its native device
ID mapping deliberately supports only the reviewed Electron/Chromium pair.
Verify the mapping with the signed device-ID GUI scenario before updating that
pair. Do not update the constants just to make CI green.
