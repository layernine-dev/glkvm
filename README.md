# GLKVM Clean

A macOS app for frameless GLKVM remote control and screen sharing. Each device
has a separate **GLKVM <name>** window with no title bar, traffic lights, toolbar,
status bar, rounded corners, or shadow. The only default connection is
`https://glkvm.local`; add your own devices in Settings. Existing saved connections
are preserved.

**⌘⇧O toggles the device interface in the same window.** It reveals the vendor
controls, a title bar and window buttons; pressing it again returns to the
clean desktop and restores its previous size and position. The window and stream
are retained. App settings (⌘,) remain separate. When sharing the device window,
its visible device settings are shared too. The menu bar identifies the focused
device as **Device — <name>**. No sharing session starts automatically.

## Run and build

```sh
cd ~/dev/glkvm
bun install
bun start
bun run check
bun run test
bun run test:gui
bun run test:devices   # optional, read-only check against this Mac's audio devices
bun run build
```

### Dependency updates

Use the newest stable releases that have completed a one-day supply chain
cooldown. `bunfig.toml` applies this minimum release age to newly resolved direct
and transitive dependencies, without package exemptions. Existing lockfile entries
are retained by ordinary installs; refresh them with `bun run deps:update`, review
the release notes, and run the checks above before shipping. This command updates
across major versions and keeps explicit semver ranges and a reproducible lockfile.
Alpha, beta, and release-candidate builds are not selected by this policy.
Do not extend the cooldown beyond 24 hours. If Bun's rapid-release stability
heuristic selects an older version, resolve the latest eligible version explicitly
through the same age gate, then retain a semver range in the manifest.

The standalone app is produced at
`dist/GLKVM Clean-darwin-arm64/GLKVM Clean.app` on Apple Silicon. Install only
the current version at `/Applications/GLKVM Clean.app`. Remove the temporary build
after installation, point the Dock entry at that path, and use Git commits and
pushes for history instead of retaining older app bundles. Increase the patch version in `package.json` for shipped
code, behavior, or asset changes. Documentation-only and test-only changes do
not need a version bump.

Builds are signed with the Mac's valid Apple Development identity from the
Keychain, including Electron helpers and frameworks, with Hardened Runtime, the
JIT entitlement required by V8, and the audio-input entitlement for connection
microphones. If several such identities exist, set
`GLKVM_SIGNING_IDENTITY` to the exact name shown by
`security find-identity -v -p codesigning`, for example
`Apple Development: Uwe Schwarz (54988A349V)`. The build fails if no identity
can be chosen or signing or verification fails; it does not fall back to an ad
hoc signature. App and helper bundle identifiers stay stable, and each Mac
should keep using the same identity so macOS can recognize future updates.
The bundled audio device catalog (`Contents/Resources/glkvm-audio-catalog`, built
from `native/audio-catalog.swift` with the Xcode command line tools) is signed
with the same identity as `dev.layernine.glkvm-clean.audio-catalog`, with
Hardened Runtime and no entitlements.
Local-network and microphone usage descriptions are included for macOS privacy prompts.

`bun start` and the GUI test commands build and verify a signed GLKVM bundle
before launching it. GUI fixtures run in a separate test bundle with the same
bundle ID, signing identity, and helper identities, using temporary profiles.
Their password storage adapter remains local to the test process and never
accesses the macOS keychain. Real Keychain integration must be checked through
the signed product app. Generic Electron launches are rejected before credentials
can be accessed. The production bundle excludes the test runner and fixtures.

The bundle identity is `dev.layernine.glkvm-clean`; helpers use the same prefix.
Before signing, packaging derives app-specific Mach-O UUIDs for the main executable
and each helper from their original Electron UUID and bundle-relative path. This
avoids collisions with Electron development runs and other Electron apps while
keeping UUIDs reproducible when rebuilding the same runtime. Apple documents UUID
collisions as a possible source of local-network privacy problems in
[TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
Migrating from the previous bundle identity may require a new network permission.

This is a local development signature, without notarization or an upload to Apple.
Switching from the original ad hoc build may require a one-time permission prompt.
Code signing preserves app identity; it does not grant privacy permissions or
prevent macOS from requesting consent under its own policies. To verify an installed
copy, run:

```sh
bun run verify:signature "/Applications/GLKVM Clean.app"
```

## Use

1. Open GLKVM Clean while connected to your LAN or VPN network.
2. Saved passwords sign in in the background; only the clean desktop window opens.
   For manual sign-in or a second factor, open Device Settings with ⌘⇧O.
   The clean window reloads once authentication succeeds, even if the hidden login
   helper has no live video. Sessions are isolated by connection ID and address.
3. Click the video to focus the remote player, then use the keyboard and mouse.
4. Select **GLKVM <name>** in your meeting
   app's window picker.

| Shortcut | Action |
| --- | --- |
| ⌘, | Open app settings |
| ⌘1 … ⌘9 | Open or focus a configured connection |
| ⌘⇧O | Show/hide device settings and window decoration in the same window |
| ⌘⇧M | Switch between controlling the desktop and dragging the window |
| ⌘R | Reload the focused device |
| ⌘W | Close the focused window |
| ⌘⇧C | Center the focused window |
| ⌘Q | Quit the app |

In view-only mode, drag anywhere on the video to move its window. In control
mode, use move mode to reposition it. Drag a window edge to resize it. The
**Window** menu offers local window sizes, fullscreen, and always-on-top. No move-mode
badge or controls are drawn over the shared video; the menu shows the mode.

**Window → Window Size** sets only the local window size from the current video
resolution: 0.25×, 0.5×, 0.75×, 1×, 1.5×, or 2×. Each item shows the resulting
pixel dimensions; **1× (1:1 pixels)** maps one video pixel to one window backing
pixel, accounting for the current display's Retina scale factor. macOS display
scaling can subsequently resample the desktop. The current matching size is checked.
Sizes outside the display's available area, above 6K, or below the minimum
160×90 logical points are disabled instead of silently reduced. Moving between
displays updates the choices. These controls do not change the remote resolution.

Shortcuts apply while the app is active. ⌘W closes only the focused window;
⌘Q quits the app and closes every window, including from move mode or device
settings. Neither shortcut is forwarded to the remote desktop. The mode toggle is registered
with macOS only while a clean window has focus, so dragging or clicking the
remote desktop does not depend on the embedded player's keyboard focus. Documented app/window shortcuts remain
local. Editing shortcuts such as ⌘C and ⌘V pass through to the remote keyboard
while the clean player is active; this does not synchronize the local clipboard.
The original device settings include keyboard layout, Command/Ctrl swapping,
mouse mode, video quality, and the vendor's other configuration panels.

## Settings and connections

Use **GLKVM Clean → Settings…** to add, rename, or remove connections. Addresses
must be full HTTP or HTTPS device origins, without credentials, paths, or query
strings. Each connection can open at startup. Save changes before using **Open**.
Saving an address change closes the old connection; use **Open** to connect to
the new address. Removing a connection closes its windows but retains its local
session data. Removing all connections opens Settings at the next launch.

### Audio per connection

Each connection has its own microphone and speaker for two situations:
**Focused window** (its window is focused, visible and not minimized, including
with device options shown) and **In background** (any other state, including
while Settings or another app is focused). Returning focus restores the focused
choices. Options are **Microphone disabled** (the default, also for existing
connections), **System default**, or a specific device; speakers offer
**System default** or a specific device. The app never changes the macOS
default input or output.

All microphones and speakers on this Mac are listed for every connection, also
while it is closed and while its microphone is disabled. The list comes from a
small bundled CoreAudio catalog that only reads device properties: it needs no
microphone permission, never opens a device and follows devices as they are
plugged in or removed. Devices with the same name show their connection type and
the end of their device UID. Choices are saved by macOS device UID, are kept when a
device is unplugged or the connection's address changes, and are shown as
unavailable while the device is missing.

Chromium gives each connection its own ID for a device (an HMAC of the device UID
with the connection's address and session salt). The app computes that ID and uses
a choice only after the connection's own page lists exactly that ID; until then,
and whenever it cannot be proven, the choice stays silent and the window muted
instead of falling back to the system default. A connection opened for the first
time needs up to about 10 seconds for this, as does one whose cookies were
cleared. This uses Electron and Chromium internals (see `src/device-ids.cjs`),
verified for Electron 44.5.1 and Chromium 152.0.7977.130; after an Electron update,
specific devices stay silent until `bun run test:gui` and `bun run test:devices`
pass with the new version and it is added there. Device choices saved by older
versions are converted only when they are exactly the ID of a current device;
others are kept and stay silent until chosen again.

The device page still decides when to use the microphone: nothing is captured
until it turns on its own microphone. Focus and settings changes switch an active
microphone to the profile's device without restarting the page's stream, and keep
the page's own microphone mute. A disabled profile, or disabling the microphone for
the whole connection, sends silence and releases the device at once, even while a
slower device is still opening; enabling it again restores the page's stream. The
device is closed when the page has stopped its microphone track and every copy of it. A selected microphone that is unavailable sends nothing; a selected
speaker that is unavailable mutes that window. Neither falls back to another
device. While a speaker change is in progress the window stays muted; each change
is numbered, so a late confirmation of an earlier choice cannot unmute it. Players
wait for a resolved speaker to be applied and reject playback if applying it fails.
While the speaker is unresolved, a player may run on its retained device, but the
window stays muted and is never rerouted to the system default. New
page audio contexts start without an output device until the selected speaker
is applied. Settings shows each open connection's microphone and speaker status
and, read-only, whether macOS microphone access was granted. App
muting in Controls still applies on top of these choices.

macOS asks once for microphone access for GLKVM Clean the first time a device page
turns on a microphone that is enabled here.

**Turn on device sound / microphone when connecting** (both off by default, also for
existing connections) set the device page's own Sound and Microphone controls when a
video session starts: a new page load, a sign-in, or a reconnect with a new video
stream. Saving does not change a running session, and changes made on the device page
afterwards are kept through focus, speaker or audio-only changes. The app uses the
firmware's own controls (`kvm.setVolumeOn`, `audioMic.setMicMuted`) once its player,
live video and USB settings are ready; it never changes the device's USB microphone
setting. The microphone turns on only if the USB microphone is enabled on the device and
the current window state has an available microphone selected here; a saved microphone
that is still being matched for a newly opened session is awaited for up to 20 seconds.
Direct H.264 mode has no device audio. A microphone start that is denied or fails
(including the device page's own microphone error) is reported once and not retried until
the page is reloaded. Turning the microphone off on the device page while it is starting
only applies to that session; the next video session turns it on again. Saving a different address turns off the connection's microphone setting;
an address that only differs in spelling (such as a trailing slash or letter case) keeps
it. App muting and the speaker choices still apply. Settings shows the result for each
open connection.

The **Controls** page sets the default keyboard/mouse mode and app audio muting.
Changing the default input mode also applies it to open KVM windows. The per-window
menu toggle lasts until the window closes or that default changes. App audio
muting does not turn on the device's own speaker setting. Hidden login helpers are always muted to avoid duplicate audio.

Local settings are stored atomically in
`~/Library/Application Support/GLKVM Clean/settings.json`. Renaming a connection
retains its login session. Changing its address uses a separate session partition;
returning to the same saved connection/address restores its prior session. Chrome
sessions remain separate.

## Certificates and permissions

For an untrusted certificate, the app shows the host, validation error, subject,
and SHA-256 fingerprint. Trust requires an explicit decision for that exact host
and certificate. A changed untrusted certificate prompts again. System and
Chrome trust settings are not modified.

Remote renderers are sandboxed with context isolation and no Node or settings
bridge. Navigation is restricted to the configured device origin. The app blocks
arbitrary popup windows, downloads, camera and clipboard permissions. Microphone
capture is allowed only for the visible connection window's main frame, on its
exact address, as an audio-only request, when that connection's current profile
has a microphone enabled. Microphone names follow the same rule; speaker selection
is allowed separately for that main frame. Subframes and hidden login helpers are
always denied, and helpers stay muted. Pointer lock is allowed for the vendor's
relative mouse mode. A small adapter installed in the page's main world before the
vendor scripts routes audio. It uses Electron's `contextBridge.executeInMainWorld`
and adds nothing to `window`. Its device and status reports are validated in the
main process.
The local settings page has its own limited IPC bridge, a restrictive content
security policy, and main-frame/sender checks. Settings contain only encrypted password data, protected by Electron safeStorage
and the macOS keychain. Plaintext passwords are never returned to the settings page.
Enter a password in App Settings and save. Pending sign-in retries in the
background; the hidden login helper reloads to use it. A blank
field keeps an existing password; **Forget saved password** removes it on save.
Changing a device address clears its saved password. Auto-login fills only the
vendor login form in a hidden authentication window, once per page load. This
window closes after successful authentication, without waiting for the vendor
console or video, and never appears automatically. Device Settings
uses the same login session and is shown only on explicit request.
Second-factor prompts require manual completion. An incorrect password is not
automatically retried; correct it in Settings and save.

## Implementation and validation

Electron provides Chromium/WebRTC and the frameless native windows. The vendor
page establishes its own connection and reconnects it. An isolated preload presents
the **original** player at the window's full size, preserving its keyboard/mouse
handlers and coordinates. View-only and move modes block remote input. Focus loss,
mode changes, and disconnects release tracked keys and mouse buttons.

The device interface is revealed in place by disabling the clean-view CSS and
input gate. Window buttons, a draggable title bar, and the shadow appear
only in this mode. A hidden helper using the same session handles saved-password
sign-in and closes when authenticated; it is never the visible settings surface.

The adapter targets the observed GLKVM 1.10.1 release3 DOM (`#stream-window`,
`#stream-box`, `#video-wrapper`, and `#stream-video` / `#stream-canvas`). Video
tracks show a waiting message after disconnection; direct canvas transport relies
on the vendor's own reconnect behavior. Firmware changes can require an adapter
update. Rotated video and relative pointer lock have not been verified live.

The startup test covers a duplicate launch handing off to the running instance
and exiting before readiness without an exception.
Unit tests cover persistence, validation, session isolation, navigation and
certificate policy. Electron tests cover edge-to-edge moving video, login/logout,
input and scroll delivery, coordinates after resizing, view-only blocking,
key/button release, moving, reconnects, integrated device controls, unchanged window identity, restored clean bounds,
connection shortcuts and active-device menus, and real settings IPC/save behavior.

The audio GUI test uses Chromium's fake microphones and speakers only and stops
before any capture if real devices appear. It covers device scoping between
connections, foreground/background/minimized routing, switching an active
microphone while keeping the page's track and mute, speaker routing for existing
and new players, rapid focus changes, unavailable devices, global mute,
permission denials and cleanup. It also covers slow speaker changes (A → B → A),
new audio contexts, refused playback when a speaker cannot be applied, players
waiting across a speaker change, copies of the microphone track or stream and
stops from other frames,
disabling and re-enabling a connection's microphone, re-listing device names, and
disabling while a slower device request is pending. The startup audio GUI test uses a scripted copy of
the firmware's stores with the same fake devices, behind the same safety gate. Real hardware, unplugging a device, and the
firmware's own microphone button still need a live check.

Live video and settings require actual devices. A passing local capture or build
does not prove sharing in a particular meeting app; Teams capture requires its
own live acceptance check.

References: [Electron window interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions),
[GLKVM console guide](https://docs.gl-inet.com/kvm/en/user_guide/gl-rm1/console_guide/).

Each connection has a **Start mode** (Window-decoration-less or Options-enabled) and **Window resolution** (Automatic, 0.25×, 0.5×, 0.75×, 1×, 1.5×, 2×). These preferences apply when reopening the connection. Scaling uses source video pixels and display density; sizes that exceed the display work area or 6K limit use automatic sizing. Window → Window Size is available in both views. In options mode, the selected scale fixes the video surface itself; the title bar, toolbar, and status content are added to the window size. The 720×500 minimum may leave extra space around small video sizes. Sizes that cannot fit with the controls are disabled. Returning to the clean view with ⌘⇧O removes that extra space. Existing connections default to the clean view and automatic sizing.

### Remote keyboard actions

Settings → Keyboard configures shortcuts for all connections. Defaults on a German
Mac keyboard are ⌘´ (the physical key next to Backspace) for Insert, ⌘⌥⌫ for
Ctrl+Alt+Delete, and ⌘V for sending clipboard text. Click a shortcut to record a new
combination, or disable it; save to apply immediately. App shortcuts are reserved.

Actions apply only while controlling the focused video, including with device
options visible. Local text fields retain normal editing. Paste uses the same
`/api/hid/print` service as the vendor Toolbox without opening its panel. Select
the remote computer's keyboard layout (German by default). Plain text and line
breaks are sent; images and formatting are not. Text expanders that trigger Cmd+V
can use this path. A failed transfer is never automatically retried because some
text may already have reached the remote computer.
