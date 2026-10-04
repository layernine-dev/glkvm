/** @typedef {{code: string, meta: boolean, control: boolean, alt: boolean, shift: boolean, label: string}} Binding */
/** @typedef {{insert: Binding | null, secureAttention: Binding | null, paste: Binding | null, pauseAudioSwitching: Binding | null, keymap: string}} KeyboardSettings */
// Remote actions; the app-wide audio switching shortcut is matched separately.
const actions = /** @type {const} */ (['insert', 'secureAttention', 'paste']);
const modifiers = /** @type {const} */ (['meta', 'control', 'alt', 'shift']);
/** @returns {KeyboardSettings} */
const defaultKeyboard = () => ({
  insert: { code: 'Equal', meta: true, control: false, alt: false, shift: false, label: '⌘´' },
  secureAttention: { code: 'Backspace', meta: true, control: false, alt: true, shift: false, label: '⌘⌥⌫' },
  paste: { code: 'KeyV', meta: true, control: false, alt: false, shift: false, label: '⌘V' },
  pauseAudioSwitching: process.platform === 'darwin'
    ? { code: 'KeyA', meta: true, control: false, alt: false, shift: true, label: '⇧⌘A' }
    : { code: 'KeyA', meta: false, control: true, alt: false, shift: true, label: '⌃⇧A' },
  keymap: 'de',
});
/** @param {Binding} binding */
const signatureOf = binding => JSON.stringify([binding.code, binding.meta, binding.control, binding.alt, binding.shift]);
/** @param {unknown} value */
function validateKeyboard(value) {
  if (value === undefined) return defaultKeyboard();
  if (!value || typeof value !== 'object') throw new Error('Invalid keyboard settings.');
  const input = /** @type {ReturnType<typeof defaultKeyboard>} */ (value);
  const result = defaultKeyboard();
  const seen = new Set();
  for (const action of [...actions, /** @type {const} */ ('pauseAudioSwitching')]) {
    let binding = input[action];
    if (binding === null) { result[action] = null; continue; }
    // Settings saved before audio switching could be paused keep their bindings; the new default yields to them.
    if (binding === undefined && action === 'pauseAudioSwitching') {
      binding = result.pauseAudioSwitching;
      if (binding && seen.has(signatureOf(binding))) { result[action] = null; continue; }
    }
    if (!binding || typeof binding.code !== 'string' || !/^(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-9]|F2[0-4]|Equal|Minus|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space)$/.test(binding.code) || !modifiers.every(key => typeof binding[key] === 'boolean') || !(binding.meta || binding.control || binding.alt) || typeof binding.label !== 'string' || binding.label.length > 80) throw new Error('Record a shortcut with Command, Control or Option.');
    if (binding.meta && !binding.control && !binding.alt && (/^Digit[1-9]$/.test(binding.code) || ['KeyQ', 'KeyW', 'KeyR', 'Comma', 'KeyH', 'KeyM'].includes(binding.code) || (binding.shift && ['KeyO', 'KeyC'].includes(binding.code)))) throw new Error('This shortcut is reserved by the app.');
    const signature = signatureOf(binding);
    if (seen.has(signature)) throw new Error('Use a different shortcut for each action.');
    seen.add(signature);
    result[action] = { code: binding.code, meta: binding.meta, control: binding.control, alt: binding.alt, shift: binding.shift, label: binding.label };
  }
  if (!['de', 'de-ch', 'en-us', 'en-gb', 'fr'].includes(input.keymap)) throw new Error('Invalid paste keyboard layout.');
  result.keymap = input.keymap;
  return result;
}
/** @param {KeyboardSettings | undefined} keyboard @param {Pick<Electron.Input, 'code' | 'meta' | 'control' | 'alt' | 'shift'>} input */
function keyboardAction(keyboard = defaultKeyboard(), input) {
  return actions.find(action => matchesBinding(keyboard[action], input));
}
/** Physical key with exactly the recorded modifiers.
 * @param {Binding | null | undefined} binding @param {Pick<Electron.Input, 'code' | 'meta' | 'control' | 'alt' | 'shift'>} input */
function matchesBinding(binding, input) {
  return !!binding && binding.code === input.code && modifiers.every(key => binding[key] === !!input[key]);
}
module.exports = { defaultKeyboard, validateKeyboard, keyboardAction, matchesBinding };
