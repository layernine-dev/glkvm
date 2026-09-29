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
bun run test:startup
bun run test:browser
bun run build
```

The standalone app is produced at
`dist/GLKVM Clean-darwin-arm64/GLKVM Clean.app` on Apple Silicon. Install only
the current version at `/Applications/GLKVM Clean.app`. Remove the temporary build
after installation, point the Dock entry at that path, and use Git commits and
pushes for history instead of retaining older app bundles. Increase the patch version in `package.json` for shipped
code, behavior, or asset changes. Documentation-only and test-only changes do
not need a version bump.

Builds are signed with the local Keychain identity
`Apple Development: Uwe Schwarz (54988A349V)`, including Electron helpers and
frameworks, with Hardened Runtime and only the JIT entitlement required by V8.
The build fails if the identity is missing or signature verification fails;
it does not fall back to an ad hoc signature. App and helper bundle identifiers
and the signing identity stay stable so macOS can recognize future updates.
A local-network usage description is included for macOS privacy prompts.

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

1. Open GLKVM Clean while connected to your LAN or Tailscale network.
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
arbitrary popup windows, downloads, and local camera, microphone, and clipboard
permissions. Pointer lock is allowed for the vendor's relative mouse mode.
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
