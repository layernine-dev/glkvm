const { ipcRenderer } = require('electron');
// Only report that this session's vendor console has a decoded image. No API is
// exposed to the page, and this window retains all original vendor controls.
window.addEventListener('DOMContentLoaded', () => {
  let reported = false;
  let attempted = false;
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
    const video = document.querySelector('#stream-video');
    const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some(input => input.getBoundingClientRect().width > 0);
    if (passwordVisible) { reported = false; void fillLogin(); return; }
    if (!reported && !passwordVisible && video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth > 0) {
      reported = true;
      ipcRenderer.send('glkvm:console-connected');
    }
  };
  ipcRenderer.on('glkvm:check-auth', () => { reported = false; check(); });
  setInterval(check, 500);
  check();
}, { once: true });
