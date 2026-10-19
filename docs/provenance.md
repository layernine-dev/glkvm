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

## Electron 45 beta runtime review (2026-10-19)

The maintainer explicitly authorized Electron 45 beta for the experimental
local-display-sleep feature in issue #1. Electron 45.0.0-beta.5 was published
on 2026-10-16 and passed the unchanged 24-hour Bun cooldown. Other dependencies
continue to follow stable releases. The GLKVM application remains on its ordinary
public release channel.

Reviewed upstream sources:

- [Electron beta 3 notes](https://github.com/electron/electron/releases/tag/v45.0.0-beta.3):
  interrupted macOS update installation no longer leaves a broken app.
- [Electron beta 4 notes](https://github.com/electron/electron/releases/tag/v45.0.0-beta.4):
  Chromium 156.0.8078.36, a macOS file-access fix, and recovery of `net.fetch`
  after a Network Service restart. The heap-profiling change affects no GLKVM API.
- [Electron beta 5 notes](https://github.com/electron/electron/releases/tag/v45.0.0-beta.5):
  Chromium backports and Node.js 24.22.0.
- [Electron media salt](https://github.com/electron/electron/blob/v45.0.0-beta.5/shell/browser/media/media_device_id_salt.cc)
  and [browser client](https://github.com/electron/electron/blob/v45.0.0-beta.5/shell/browser/electron_browser_client.cc):
  compared with beta 1, the salt file is identical and the browser-client changes
  concern geolocation only. Persistent session salt selection is unchanged.
- [Chromium device-ID mapping](https://github.com/chromium/chromium/blob/156.0.8078.36/content/browser/media/media_devices_util.cc)
  and [CoreAudio UID lookup](https://github.com/chromium/chromium/blob/156.0.8078.36/media/audio/mac/core_audio_util_mac.cc)
  are identical to 156.0.8078.12.
  HMAC-SHA256 still uses the serialized origin as key and raw UID followed by
  device salt as input. Default/communications IDs pass through.
- [undici 7.30.1 notes](https://github.com/nodejs/undici/releases/tag/v7.30.1):
  security fixes for the transitive build-time HTTP client, including certificate
  handling and bounded parser/buffer state. It is not shipped in the app.

The signed device-ID GUI scenario and read-only real-device scenario validate
the runtime pairing; they do not prove physical KVM sleep/wake acceptance.
