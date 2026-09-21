/* global settings */
let config;
let dirty = false;
const list = document.querySelector('#device-list');
const status = document.querySelector('#save-status');
function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}
function changed() { dirty = true; message('Unsaved changes'); }
function render() {
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
    row.innerHTML = `<div class="device-fields"><label for="name-${index}">Name</label><input id="name-${index}" type="text" maxlength="60" required autocomplete="off"><label for="address-${index}">Address</label><input id="address-${index}" type="url" required placeholder="https://device.example" autocomplete="off" spellcheck="false"><label for="password-${index}">Password</label><input id="password-${index}" type="password" autocomplete="new-password" maxlength="4096"><span></span><button type="button" class="forget">Forget saved password</button><label for="mode-${index}">Start mode</label><select id="mode-${index}" class="start-mode"><option value="window-decoration-less">Window-decoration-less</option><option value="options-enabled">Options-enabled</option></select><label for="scale-${index}">Window resolution</label><select id="scale-${index}" class="window-scale"><option value="">Automatic</option>${[0.25, 0.5, 0.75, 1, 1.5, 2].map(scale => `<option value="${scale}">${scale}×</option>`).join('')}</select></div><div class="device-bottom"><label class="check"><input type="checkbox"> Open at startup</label><div class="device-actions"><button type="button" class="open">Open</button><button type="button" class="remove">Remove</button></div></div>`;
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
    row.querySelector('.open').addEventListener('click', async () => {
      if (dirty || !device.id) { message('Save your changes before opening a connection.'); return; }
      try { await settings.open(device.id); } catch (error) { message(error.message, true); }
    });
    list.append(row);
  });
  document.querySelector('#add-device').disabled = config.devices.length >= 32;
}
for (const section of ['connections', 'controls']) {
  document.querySelector(`#${section}-tab`).addEventListener('click', () => {
    for (const id of ['connections', 'controls']) {
      document.querySelector(`#${id}`).hidden = id !== section;
      document.querySelector(`#${id}-tab`).classList.toggle('selected', id === section);
      document.querySelector(`#${id}-tab`).setAttribute('aria-pressed', String(id === section));
    }
  });
}
document.querySelector('#add-device').addEventListener('click', () => {
  config.devices.push({ id: '', name: '', origin: '', openAtStartup: true });
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
settings.load().then(value => {
  config = value;
  document.querySelector('#control-enabled').checked = config.controlEnabled;
  document.querySelector('#muted').checked = config.muted;
  render();
}).catch(error => { message(error.message, true); document.querySelector('#save').disabled = true; });
