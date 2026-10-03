/* global settings */
let config;
let dirty = false;
let audio = {};
const list = document.querySelector('#device-list');
const status = document.querySelector('#save-status');
function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}
function changed() { dirty = true; message('Unsaved changes'); }
function render() {
  renderKeyboard();
  list.replaceChildren();
  if (!config.devices.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No connections yet. Add a device to get started.';
    list.append(empty);
  }
  config.devices.forEach((device, index) => {
    const row = document.createElement('div');
    row.className = 'device';
    row.innerHTML = `<div class="device-fields"><label for="name-${index}">Name</label><input id="name-${index}" type="text" maxlength="60" required autocomplete="off"><label for="address-${index}">Address</label><input id="address-${index}" type="url" required placeholder="https://device.example" autocomplete="off" spellcheck="false"><label for="password-${index}">Password</label><input id="password-${index}" type="password" autocomplete="new-password" maxlength="4096"><span></span><button type="button" class="forget">Forget saved password</button><label for="mode-${index}">Start mode</label><select id="mode-${index}" class="start-mode"><option value="window-decoration-less">Window-decoration-less</option><option value="options-enabled">Options-enabled</option></select><label for="scale-${index}">Window resolution</label><select id="scale-${index}" class="window-scale"><option value="">Automatic</option>${[0.25, 0.5, 0.75, 1, 1.5, 2].map(scale => `<option value="${scale}">${scale}×</option>`).join('')}</select></div><div class="audio" role="group" aria-label="Audio"></div><div class="device-bottom"><label class="check"><input type="checkbox"> Open at startup</label><div class="device-actions"><button type="button" class="open">Open</button><button type="button" class="remove">Remove</button></div></div>`;
    const name = row.querySelector('input[type=text]');
    const address = row.querySelector('input[type=url]');
    const password = row.querySelector('input[type=password]');
    password.placeholder = device.hasPassword ? 'Saved — leave blank to keep' : 'Optional device login password';
    password.value = device.password || '';
    const forget = row.querySelector('.forget');
    forget.hidden = !device.hasPassword;
    forget.addEventListener('click', () => { device.removePassword = true; device.hasPassword = false; device.password = ''; render(); changed(); });
    password.addEventListener('input', () => { device.password = password.value; device.removePassword = false; changed(); });
    const mode = row.querySelector('.start-mode');
    const scale = row.querySelector('.window-scale');
    mode.value = device.startMode || 'window-decoration-less';
    scale.value = device.windowScale == null ? '' : String(device.windowScale);
    mode.addEventListener('change', () => { device.startMode = mode.value; changed(); });
    scale.addEventListener('change', () => { device.windowScale = scale.value === '' ? null : Number(scale.value); changed(); });
    const startup = row.querySelector('input[type=checkbox]');
    name.value = device.name;
    address.value = device.origin;
    startup.checked = device.openAtStartup;
    name.addEventListener('input', () => { device.name = name.value; changed(); });
    address.addEventListener('input', () => { device.origin = address.value; changed(); });
    startup.addEventListener('change', () => { device.openAtStartup = startup.checked; changed(); });
    row.querySelector('.remove').addEventListener('click', () => {
      config.devices.splice(index, 1); render(); changed();
    });
    const audioGroup = row.querySelector('.audio');
    renderAudio(audioGroup, device);
    // A refresh skipped while a choice was in progress applies once focus leaves the group.
    audioGroup.addEventListener('focusout', () => setTimeout(() => {
      if (!audioGroup.contains(document.activeElement) && staleAudio.delete(audioGroup)) renderAudio(audioGroup, device);
    }));
    row.querySelector('.open').addEventListener('click', async () => {
      if (dirty || !device.id) { message('Save your changes before opening a connection.'); return; }
      try { await settings.open(device.id); } catch (error) { message(error.message, true); }
    });
    list.append(row);
  });
  document.querySelector('#add-device').disabled = config.devices.length >= 32;
}
for (const section of ['connections', 'controls', 'keyboard']) {
  document.querySelector(`#${section}-tab`).addEventListener('click', () => {
    for (const id of ['connections', 'controls', 'keyboard']) {
      document.querySelector(`#${id}`).hidden = id !== section;
      document.querySelector(`#${id}-tab`).classList.toggle('selected', id === section);
      document.querySelector(`#${id}-tab`).setAttribute('aria-pressed', String(id === section));
    }
  });
}
document.querySelector('#add-device').addEventListener('click', () => {
  config.devices.push({ id: '', name: '', origin: '', openAtStartup: true, audio: defaultAudio() });
  render(); changed();
  list.lastElementChild.querySelector('input').focus();
});
document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  config.controlEnabled = document.querySelector('#control-enabled').checked;
  config.muted = document.querySelector('#muted').checked;
  document.querySelector('#save').disabled = true;
  try {
    const result = await settings.save(config);
    if (!result.ok) { message(result.error, true); return; }
    config = result.config; dirty = false; render(); message('Changes saved');
  } catch (error) { message(error.message, true); }
  finally { document.querySelector('#save').disabled = false; }
});
document.querySelector('#control-enabled').addEventListener('change', changed);
document.querySelector('#muted').addEventListener('change', changed);
settings.load().then(async value => {
  config = value;
  document.querySelector('#control-enabled').checked = config.controlEnabled;
  document.querySelector('#muted').checked = config.muted;
  render();
  settings.onAudio(snapshot => { audio = snapshot; refreshAudio(); });
  audio = await settings.audio();
  refreshAudio();
}).catch(error => { message(error.message, true); document.querySelector('#save').disabled = true; });

function renderKeyboard() {
  const container = document.querySelector('#keyboard-bindings');
  container.replaceChildren();
  for (const [action, title] of [['insert', 'Insert'], ['secureAttention', 'Ctrl + Alt + Delete'], ['paste', 'Paste clipboard as text']]) {
    const row = document.createElement('div'); row.className = 'setting-row';
    const label = document.createElement('strong'); label.textContent = title;
    const record = document.createElement('button'); record.type = 'button';
    record.textContent = config.keyboard[action]?.label || 'Disabled';
    record.setAttribute('aria-label', `${title} shortcut: ${record.textContent}`);
    let recording = false;
    record.addEventListener('click', () => { recording = true; record.textContent = 'Press shortcut…'; });
    record.addEventListener('blur', () => { recording = false; record.textContent = config.keyboard[action]?.label || 'Disabled'; });
    record.addEventListener('keydown', event => {
      if (!recording) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { record.blur(); return; }
      if ((!event.metaKey && !event.ctrlKey && !event.altKey) || /^(Meta|Control|Alt|Shift)$/.test(event.key)) return;
      const key = event.key === 'Dead' ? event.code : event.key.toUpperCase();
      config.keyboard[action] = { code: event.code, meta: event.metaKey, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, label: `${event.ctrlKey ? '⌃' : ''}${event.altKey ? '⌥' : ''}${event.shiftKey ? '⇧' : ''}${event.metaKey ? '⌘' : ''}${key}` };
      changed(); record.blur();
    });
    const disable = document.createElement('button'); disable.type = 'button'; disable.textContent = 'Disable';
    disable.setAttribute('aria-label', `Disable ${title}`);
    disable.addEventListener('click', () => { config.keyboard[action] = null; changed(); renderKeyboard(); });
    row.append(label, record, disable); container.append(row);
  }
  document.querySelector('#paste-keymap').value = config.keyboard.keymap;
}
document.querySelector('#paste-keymap').addEventListener('change', event => { config.keyboard.keymap = event.target.value; changed(); });

// Devices come from the Mac's audio catalog, so every connection can choose them,
// open or not. Choices are saved by device UID and resolved inside each connection.
function defaultAudio() {
  return { foreground: { input: 'disabled', output: 'default' }, background: { input: 'disabled', output: 'default' } };
}
const audioProfiles = [['foreground', 'focused'], ['background', 'in background']];
function choiceValue(choice) {
  if (typeof choice !== 'object') return choice;
  return 'uid' in choice ? `uid:${choice.uid}` : `legacy:${choice.deviceId}`;
}
/** Audio groups whose refresh waits for focus to leave them. */
const staleAudio = new WeakSet();
function refreshAudio() {
  config.devices.forEach((device, index) => {
    const container = list.children[index]?.querySelector('.audio');
    if (!container) return;
    // Rebuilding would interrupt the focused dropdown; keep the status current meanwhile.
    if (container.contains(document.activeElement)) {
      staleAudio.add(container);
      container.querySelector('.audio-status').textContent = audioStatus(device, device.id ? audio.connections?.[device.id] : undefined);
    } else renderAudio(container, device);
  });
}
function renderAudio(container, device) {
  device.audio ||= defaultAudio();
  const live = device.id ? audio.connections?.[device.id] : undefined;
  container.replaceChildren();
  const heading = document.createElement('span'); heading.className = 'audio-title'; heading.textContent = 'Audio';
  const focused = document.createElement('span'); focused.className = 'audio-column'; focused.textContent = 'Focused window';
  const background = document.createElement('span'); background.className = 'audio-column'; background.textContent = 'In background';
  container.append(heading, focused, background);
  for (const [kind, title, available] of [['input', 'Microphone', audio.catalog?.inputs], ['output', 'Speaker', audio.catalog?.outputs]]) {
    const label = document.createElement('span'); label.className = 'audio-label'; label.textContent = title;
    container.append(label);
    for (const [profile, description] of audioProfiles) {
      const select = document.createElement('select');
      select.className = `audio-${profile}-${kind}`;
      select.setAttribute('aria-label', `${title} ${description} for ${device.name || 'this connection'}`);
      const options = [...(kind === 'input' ? [['disabled', 'Microphone disabled']] : []), ['default', 'System default']];
      for (const item of available || []) options.push([`uid:${item.uid}`, item.alive ? item.label : `${item.label} — not available`]);
      const choice = device.audio[profile][kind];
      if (typeof choice === 'object' && !options.some(([value]) => value === choiceValue(choice))) options.push([choiceValue(choice), `${choice.label || title} — not available`]);
      for (const [value, text] of options) {
        const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
      }
      select.value = choiceValue(choice);
      select.addEventListener('change', () => {
        const value = select.value;
        const selected = (available || []).find(item => `uid:${item.uid}` === value);
        device.audio[profile][kind] = selected ? { uid: selected.uid, label: selected.label } : value === choiceValue(choice) ? choice : value;
        changed();
        container.querySelector('.audio-status').textContent = audioStatus(device, live);
      });
      container.append(select);
    }
  }
  const status = document.createElement('p'); status.className = 'audio-status'; status.setAttribute('role', 'status');
  status.textContent = audioStatus(device, live);
  container.append(status);
}
function audioStatus(device, live) {
  const parts = [];
  if (!audio.catalog) parts.push('Loading audio devices…');
  const microphone = device.audio.foreground.input !== 'disabled' || device.audio.background.input !== 'disabled';
  if (microphone && audio.microphoneAccess && audio.microphoneAccess !== 'granted') {
    parts.push({ 'not-determined': 'macOS asks for microphone access when the device page first turns on its microphone.', denied: 'Microphone access is off for GLKVM Clean in System Settings → Privacy & Security → Microphone.', restricted: 'Microphone access is restricted on this Mac.' }[audio.microphoneAccess] || '');
  }
  if (!live) parts.push('Choices apply while this connection is open.');
  else if (live.preparing) parts.push('Preparing the selected devices for this connection — silent until ready.');
  const state = live?.status;
  if (state) {
    const profile = live.foreground ? 'focused' : 'background';
    const input = { idle: 'Microphone not in use by the device page.', live: `Microphone sending (${profile} setting).`, disabled: `Microphone silent (${profile} setting: disabled).`, missing: 'Selected microphone unavailable — not sending audio.', denied: 'Microphone access denied. Check System Settings → Privacy & Security → Microphone.', error: 'Microphone could not be started — not sending audio.' }[state.input];
    const output = { ok: '', pending: 'Switching speaker — muted until it is ready.', missing: 'Selected speaker unavailable — this window is muted.', error: 'Speaker could not be selected — this window is muted.' }[state.outputState];
    parts.push(input, output);
  }
  if (dirty) parts.push('Save to apply changes.');
  return parts.filter(Boolean).join(' ');
}
