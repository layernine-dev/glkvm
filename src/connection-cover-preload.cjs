const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const status = document.querySelector('#status');
  const name = document.querySelector('#name');
  ipcRenderer.on('glkvm:cover-status', (_event, state) => {
    if (!status || !name) return;
    if (status.textContent !== state.message) status.textContent = state.message;
    if (name.textContent !== state.name) name.textContent = state.name;
    document.body.classList.toggle('busy', state.busy === true);
  });
  for (const button of document.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => ipcRenderer.send('glkvm:cover-action', button.getAttribute('data-action')));
  }
}, { once: true });
