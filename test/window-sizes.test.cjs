const { test } = require('node:test');
const assert = require('node:assert/strict');
const { windowSize } = require('../src/window-sizes.cjs');

test('1:1 window size accounts for standard and Retina display density', () => {
  const source = { width: 1920, height: 1080 };
  const work = { width: 3000, height: 2000 };
  assert.deepEqual(windowSize(source, 1, work, 1), { ...source, fits: true });
  assert.deepEqual(windowSize(source, 1, work, 2), { width: 960, height: 540, fits: true });
  assert.deepEqual(windowSize(source, 0.25, work, 2), { width: 240, height: 135, fits: true });
});

test('unavailable scales retain their requested dimensions instead of being silently clamped', () => {
  const work = { width: 1440, height: 900 };
  assert.deepEqual(windowSize({ width: 3840, height: 2160 }, 1, work, 2), { width: 1920, height: 1080, fits: false });
  assert.deepEqual(windowSize({ width: 640, height: 360 }, 0.25, work, 2), { width: 80, height: 45, fits: false });
  assert.equal(windowSize({ width: 3840, height: 2160 }, 2, { width: 10000, height: 8000 }, 1).fits, false);
});
