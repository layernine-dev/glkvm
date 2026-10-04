# Releases and updates

Every merge to main is live after CI succeeds. There are no release PRs, test
channels or prereleases. Tests and releases execute on the trusted macOS runner.
The repository and GitHub Releases are public. Official release bundles enable
automatic updates through `updatesEnabled: true` in `release.json`; development
and GUI-test bundles always keep updates disabled.
The workflow has a FIFO concurrency queue (up to GitHub's 100-run limit) and
never cancels an in-progress release when another merge arrives.

## One-time setup

1. Keep the upstream GitHub repository public for `update.electronjs.org`. No
   GitHub token is shipped in the app. Install the first updater-enabled release
   manually from GitHub; subsequent versions can update automatically.
2. On the macOS runner, install the project's **Developer ID Application** certificate with
   its private key in the signing Keychain. An **Apple Development** certificate
   remains the correct identity for local development/GUI tests but cannot replace
   Developer ID for public notarized distribution. Preserve the existing identity.
3. Store notarization credentials in a local Keychain profile using Xcode's
   interactive command (Apple Developer membership and suitable credentials are
   required):

   ```sh
   xcrun notarytool store-credentials glkvm-notary
   ```

   Use Apple's prompted Apple-ID/team/app-specific-password flow or its supported
   App Store Connect API-key flow. Do not put credentials in Git or issue comments.
4. Set repository variable `GLKVM_NOTARY_PROFILE` to `glkvm-notary`. Optionally set
   `GLKVM_RELEASE_SIGNING_IDENTITY` to the exact Developer ID identity name when
   multiple valid identities are installed. These are names, not secret values.
5. Run `GLKVM_NOTARY_PROFILE=glkvm-notary bun run release:check` on the macOS runner. This only
   selects the certificate and reads notarization history; it uploads nothing.
6. Allow GitHub Actions to create PRs for the dependency workflow. Both trusted
   developers can contribute without sharing signing private keys. This project
   does not use branch protection; review PRs and their macOS checks before merging.

The runner needs GitHub CLI and the existing signed runner's Keychain access.
The release job's temporary `GITHUB_TOKEN` has `contents: write`; the dependency
job additionally needs PR creation permission. The Actions actor policy allows
only keeperxy and uwe-schwarz; bot PRs require a maintainer to dispatch CI.

## Build and publish

CI tests the event's exact SHA, then checks out that same SHA with full history
for release. It uses the frozen lockfile. Version `0.1.21` is anchored to the
commit in `release.json`; each subsequent first-parent commit adds one patch.
The generated version is written only into the packaged app, never back to Git.

The release build keeps the existing app/helper bundle IDs and Mach-O UUID
derivation, signs with Developer ID and secure timestamps, uploads a ZIP to
Apple's notary service, requires `Accepted`, staples and validates the ticket,
checks Gatekeeper and licenses, then recreates the final ZIP with the ticket.
Minimum macOS is the major version used on the build host; maintain the macOS runner on the
latest stable macOS. Only arm64 is built.

CI uploads the ZIP, SHA256SUMS and release metadata to a draft, checks GitHub's
asset sizes and SHA-256 digests, then publishes it immediately. The draft is a
transaction boundary, not an approval stage. A published tag must resolve to the
tested SHA. Published assets are never replaced on retries.

Failures remain visible as failed workflow runs. Fix missing credentials or
notarization errors and rerun the failed release job. An already published version
is verified and left intact. A bad application release is repaired with a new PR
and higher version; do not overwrite old ZIPs or move tags backwards.

## App updates and initial installation

Official release bundles use `update-electron-app` with the public service
`update.electronjs.org`. The publisher verifies public repository visibility
before uploading and again before publication. License texts remain accessible
through Open Source Licenses.

The integration checks at startup
and hourly, downloads in the background and offers the native Restart / Later
dialog. The app menu also provides Check for Updates. KVM input is released before
update shutdown. The package's downloaded update is installed on the next normal
start if restart is deferred. Network errors do not stop the app.

Development and GUI-test bundles always disable updates even though they are
packaged. Unit tests cover this gate and the GUI suite verifies that its update
menu is disabled.

Existing development installations and older releases with updates disabled need
a manual installation of the first updater-enabled official build. Keep the same `/Applications/GLKVM Clean.app`
path, bundle ID and user-data directory. The switch from Apple Development to
Developer ID changes the code-signing requirement; do not promise that existing
Keychain/TCC consent will carry over. Validate saved-password access in the signed
product app without deleting keys or changing ACLs.

When validating the first automatic upgrade, verify a real signed/notarized A-to-B update on
a test Mac: download, restart, new version, preserved settings and credentials,
and continued microphone/network permissions. Also verify offline behavior and
rejection of an invalidly signed update. Fixture tests alone do not certify this
Apple-dependent path.
