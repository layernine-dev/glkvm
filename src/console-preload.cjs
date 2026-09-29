const { ipcRenderer } = require('electron');
// Report successful session authentication. No API is
// exposed to the page, and this window retains all original vendor controls.
window.addEventListener('DOMContentLoaded', () => {
  let reported = false;
  let attempted = false;
  const sessionToken = () => {
    try {
      const token = JSON.parse(localStorage.getItem('gl-kvm-token-keys') || '{}').glkvm;
      return typeof token === 'string' && token ? token : null;
    } catch { return null; }
  };
  const initialToken = sessionToken();
  const fillLogin = async () => {
    const container = document.querySelector('.auth-form-container');
    const input = container?.querySelector('form.login-form input[type="password"]');
    const button = container?.querySelector('button.operation-btn');
    if (!container || attempted || !(input instanceof HTMLInputElement) || input.type !== 'password' || !input.getBoundingClientRect().width || input.value || !(button instanceof HTMLButtonElement) || button.disabled || container?.querySelector('.ant-spin-spinning')) return;
    attempted = true;
    const password = await ipcRenderer.invoke('glkvm:login-password');
    if (!password || !input.isConnected || input.value || !input.getBoundingClientRect().width) return;
    input.value = password;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Leave any second factor to the user; never retry rejected credentials.
    if (![...container.querySelectorAll('form.login-form input')].some(field => field !== input && field.getBoundingClientRect().width > 0)) {
      setTimeout(() => { if (button.isConnected && !button.disabled) button.click(); }, 0);
    }
  };
  const check = () => {
    // Firmware persists this token only after successful authentication,
    // including any second factor. Its console can remain on the connecting
    // screen afterwards, so do not wait for its player to mount or decode video.
    const token = sessionToken();
    if (!reported && token && token !== initialToken) {
      reported = true;
      ipcRenderer.send('glkvm:console-authenticated');
      return;
    }
    const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some(input => input.getBoundingClientRect().width > 0);
    if (passwordVisible) { void fillLogin(); return; }
    // The authenticated console can have no decoded video (including canvas
    // transport or no HDMI signal). The visible page still needs a fresh load
    // to pick up the session established in this helper.
    const consoleRoute = ['', '#/', '#/kvm'].includes(location.hash.split('?')[0]);
    if (!reported && consoleRoute && !document.querySelector('.auth-form-container') && document.querySelector('#stream-window #stream-box')) {
      reported = true;
      ipcRenderer.send('glkvm:console-authenticated');
    }
  };
  ipcRenderer.on('glkvm:check-auth', () => { reported = false; check(); });
  setInterval(check, 500);
  check();
}, { once: true });
