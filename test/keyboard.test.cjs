const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultKeyboard, validateKeyboard, keyboardAction, matchesBinding } = require('../src/keyboard.cjs');
const { defaults, validateConfig } = require('../src/config.cjs');
test('old settings migrate and disabled or reassigned shortcuts survive validation', () => {
  const config = defaults(); delete config.keyboard;
  assert.deepEqual(validateConfig(config).keyboard, defaultKeyboard());
  const keyboard = defaultKeyboard(); keyboard.insert = null;
  assert.equal(validateKeyboard(keyboard).insert, null);
  assert.ok(keyboard.paste);
  keyboard.paste.code = 'KeyP'; keyboard.paste.shift = true;
  assert.deepEqual(validateKeyboard(keyboard), keyboard);
});
test('duplicate and reserved shortcuts are rejected before saving', () => {
  const keyboard = defaultKeyboard(); keyboard.insert = keyboard.paste;
  assert.throws(() => validateKeyboard(keyboard), /different shortcut/);
  assert.ok(keyboard.paste);
  keyboard.insert = { ...keyboard.paste, code: 'KeyQ' };
  assert.throws(() => validateKeyboard(keyboard), /reserved/);
});
test('physical key matching supports dead keys and requires exact modifiers', () => {
  const input = { type: 'keyDown', key: 'Dead', code: 'Equal', meta: true, control: false, shift: false, alt: false, isAutoRepeat: false };
  assert.equal(keyboardAction(defaultKeyboard(), input), 'insert');
  assert.equal(keyboardAction(defaultKeyboard(), { ...input, alt: true }), undefined);
  assert.equal(keyboardAction({ ...defaultKeyboard(), insert: null }, input), undefined);
});
test('saved shortcuts gain the pause audio switching default and keep their bindings', () => {
  const pause = defaultKeyboard().pauseAudioSwitching;
  assert.deepEqual(pause, process.platform === 'darwin'
    ? { code: 'KeyA', meta: true, control: false, alt: false, shift: true, label: '⇧⌘A' }
    : { code: 'KeyA', meta: false, control: true, alt: false, shift: true, label: '⌃⇧A' });
  /** @type {Record<string, unknown>} */
  const saved = { ...defaultKeyboard(), insert: null, paste: { code: 'KeyP', meta: true, control: false, alt: false, shift: true, label: '⇧⌘P' }, keymap: 'fr' };
  delete saved.pauseAudioSwitching;
  assert.deepEqual(validateKeyboard(saved), { ...saved, pauseAudioSwitching: pause });
  // A saved binding already on the new default keeps it; pausing starts out disabled.
  assert.ok(pause);
  const taken = { ...saved, paste: { ...pause, label: 'Mine' } };
  assert.deepEqual(validateKeyboard(taken), { ...taken, pauseAudioSwitching: null });
  const config = defaults(); config.keyboard = /** @type {any} */ (saved);
  assert.deepEqual(validateConfig(config).keyboard?.pauseAudioSwitching, pause);
});
test('pause audio switching can be disabled or reassigned and is checked for collisions', () => {
  const keyboard = defaultKeyboard(); keyboard.pauseAudioSwitching = null;
  assert.equal(validateKeyboard(keyboard).pauseAudioSwitching, null, 'A disabled shortcut is not restored to the default');
  keyboard.pauseAudioSwitching = { code: 'F8', meta: false, control: true, alt: true, shift: false, label: '⌃⌥F8' };
  assert.deepEqual(validateKeyboard(keyboard), keyboard);
  assert.ok(keyboard.insert);
  assert.throws(() => validateKeyboard({ ...keyboard, pauseAudioSwitching: { ...keyboard.insert } }), /different shortcut/);
  assert.throws(() => validateKeyboard({ ...keyboard, pauseAudioSwitching: { code: 'KeyM', meta: true, control: false, alt: false, shift: true, label: '⇧⌘M' } }), /reserved/);
  assert.throws(() => validateKeyboard({ ...keyboard, pauseAudioSwitching: { code: 'KeyA', meta: false, control: false, alt: false, shift: true, label: '⇧A' } }), /Command, Control or Option/);
});
test('pause audio switching matches exact modifiers and is not a remote action', () => {
  const keyboard = defaultKeyboard();
  const pause = keyboard.pauseAudioSwitching; assert.ok(pause);
  const input = { code: 'KeyA', meta: pause.meta, control: pause.control, alt: false, shift: true };
  assert.equal(matchesBinding(pause, input), true);
  assert.equal(matchesBinding(pause, { ...input, shift: false }), false, 'Select All stays a remote key');
  assert.equal(matchesBinding(pause, { ...input, alt: true }), false);
  assert.equal(matchesBinding(pause, { ...input, code: 'KeyS' }), false);
  assert.equal(matchesBinding(null, input), false);
  assert.equal(keyboardAction(keyboard, input), undefined);
});
