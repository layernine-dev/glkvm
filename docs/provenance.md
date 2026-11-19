# Source and third-party provenance

GLKVM Clean's own code is distributed under the root MIT license. It is an
independent project, not an official GL.iNet product. GL.iNet's device firmware
and web interface are not licensed by this project's MIT grant.

## Application and fixtures

The app loads the configured device's web interface over the network and adapts
it using the project's preloads. No downloaded vendor firmware bundle, font,
logo or minified vendor JavaScript is present in the tracked source tree reviewed
on 2026-10-04.

`test/fixture.html` is a synthetic login/video/input surface (introduced in
389ff76). `test/startup-audio-app.cjs` implements a small fake store/API model
(introduced in 345a150 and extended in subsequent tests). Its call logs, fault
injection and fake-media behavior are test scaffolding; device DOM identifiers,
store names and method names mirror observed interfaces for compatibility.
Reviewing these files and their introduction commits found no embedded vendor
bundle or vendor source header. This is a source/history review, not proof of
independent authorship of every line. The original observation record referenced
as `/tmp/glkvm-startup-audio/evidence.md` was unavailable during this review.
Future imported snippets must carry their source and applicable license.

The app icon was generated specifically for this project; its generation prompt
and derivation are recorded in [assets/README.md](../assets/README.md). It is not a
copied manufacturer logo. Test sources are excluded from official app bundles.

## Distributed dependency notices

The packaging hooks copy the actual Electron distribution's `LICENSE` and
`LICENSES.chromium.html` into `Contents/Resources/licenses` before signing. They
include Electron, Chromium and the components attributed by that runtime.
After pruning build-only dependencies, the build collects license/copyright/notice
texts from every shipped Node package, including nested runtime dependencies.
An inventory and SHA-256 manifest are included and verified after packaging.

The initial updater dependency tree is:

| Package | Declared license | Notice source |
| --- | --- | --- |
| update-electron-app 3.3.0 | MIT | package LICENSE |
| github-url-to-object 4.0.6 | MIT | reviewed supplement below |
| is-url 1.2.4 | MIT | package LICENSE-MIT |
| ms 2.1.3 | MIT | package license.md |

`github-url-to-object@4.0.6` declares MIT in both its package manifest and README,
but its published package and corresponding upstream tag have no standalone
license/copyright text. The supplement in `third_party/github-url-to-object@4.0.6`
preserves those upstream files and author metadata and reproduces standard MIT
terms, explicitly documenting the absent copyright notice. No copyright year or
holder has been invented. The supplement is version-specific; upgrading that
package requires reviewing the new upstream distribution rather than silently
reusing it.

The build fails on any other shipped dependency without a license text. Existing
upstream notices remain intact, and the project's license does not replace them.
Use `bun run licenses:check` to verify the app's complete bundled notice inventory.

## Electron 45 runtime review (2026-11-19)

The maintainer authorized Electron 45 beta for the experimental local-display-sleep
feature in issue #1. Electron 45 is now stable, so the app has returned to stable
Electron releases. Electron 45.3.4 was published on 2026-11-17 and passed the
unchanged 24-hour Bun cooldown. The GLKVM application remains on its ordinary
public release channel.

Reviewed upstream sources:

- [Electron 45.0.0 notes](https://github.com/electron/electron/releases/tag/v45.0.0):
  Chromium 156.0.8078.48. The listed breaking changes were already part of the
  reviewed beta line. GLKVM already uses asynchronous `safeStorage` and clipboard
  reads, and has no sandboxed preload `Buffer`/timer use or login-item options.
  Beta 6 also added the eMudhra intermediate-certificate mitigation.
- [Electron 45.1.0](https://github.com/electron/electron/releases/tag/v45.1.0),
  [45.2.0](https://github.com/electron/electron/releases/tag/v45.2.0),
  [45.2.1](https://github.com/electron/electron/releases/tag/v45.2.1),
  [45.2.2](https://github.com/electron/electron/releases/tag/v45.2.2) and
  [45.2.3](https://github.com/electron/electron/releases/tag/v45.2.3) notes:
  Chromium 156.0.8078.80, Node.js 24.22.2, upstream security backports, and fixes
  for macOS `Menu.popup()`, `utilityProcess` exit on quit and asar handling.
- [Electron 45.3.0](https://github.com/electron/electron/releases/tag/v45.3.0),
  [45.3.1](https://github.com/electron/electron/releases/tag/v45.3.1),
  [45.3.2](https://github.com/electron/electron/releases/tag/v45.3.2),
  [45.3.3](https://github.com/electron/electron/releases/tag/v45.3.3) and
  [45.3.4](https://github.com/electron/electron/releases/tag/v45.3.4) notes:
  Chromium 156.0.8078.100, Node.js 24.22.3, upstream security backports, the
  revoked eMudhra RSA intermediates, a macOS notification observer hang and leak,
  cookies saved shortly before quitting, and `hasShadow`/`setHasShadow()` in
  macOS app shims (not used by GLKVM, whose windows set shadows directly).
- [Electron media salt](https://github.com/electron/electron/blob/v45.3.4/shell/browser/media/media_device_id_salt.cc)
  and [browser client](https://github.com/electron/electron/blob/v45.3.4/shell/browser/electron_browser_client.cc):
  identical to 45.2.3; compared with beta 5, the salt files are identical and
  `GetMediaDeviceIDSalt` is unchanged. Other browser-client changes concern extensions, service workers
  and popup startup data. Persistent session salt selection is unchanged.
- [Chromium device-ID mapping](https://github.com/chromium/chromium/blob/156.0.8078.100/content/browser/media/media_devices_util.cc),
  [CoreAudio UID lookup](https://github.com/chromium/chromium/blob/156.0.8078.100/media/audio/mac/core_audio_util_mac.cc)
  and [WebRTC mDNS gate](https://github.com/chromium/chromium/blob/156.0.8078.100/third_party/blink/renderer/modules/peerconnection/peer_connection_dependency_factory.cc)
  are identical to 156.0.8078.80 and 156.0.8078.36.
  HMAC-SHA256 still uses the serialized origin as key and raw UID followed by
  device salt as input. Default/communications IDs pass through.
- [undici 7.30.2 notes](https://github.com/nodejs/undici/releases/tag/v7.30.2):
  cache and redirect security fixes for the transitive build-time HTTP client.
  It is not shipped in the app.
- [electron/osx-sign 2.7.2](https://github.com/electron/osx-sign/releases/tag/v2.7.2)
  resolves identity names when signing with a certificate hash. semver 7.8.6,
  `@electron-internal/extract-zip` 1.0.8 and `@types/node` 26.6.6 are build or
  type-checking dependencies.
- [`@electron/asar` 4.3.2](https://github.com/electron/asar/releases/tag/v4.3.2)
  moves its build-time archive globbing to [glob 14](https://github.com/isaacs/node-glob/blob/main/changelog.md)
  (14.0.6), minimatch 11.0.9, path-scurry 3.0.0 and the new
  `@isaacs/nonrecursive-glob-match` 1.1.0, which replaces pattern regular
  expressions to prevent ReDoS. GLKVM passes no asar glob patterns; the archive
  is verified by the signed build and `licenses:check`. graceful-fs 4.2.12 and
  brace-expansion 5.0.13 are patch updates. None of these packages is shipped.

The signed device-ID GUI scenario and read-only real-device scenario validate
the runtime pairing; they do not prove physical KVM sleep/wake acceptance.
