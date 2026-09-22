const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultKeyboard, validateKeyboard, keyboardAction } = require('../src/keyboard.cjs');
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
