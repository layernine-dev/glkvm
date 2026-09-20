const scales = [0.25, 0.5, 0.75, 1, 1.5, 2];
/**
 * Convert video pixels to local window points without silently changing scale.
 * @param {{width: number, height: number}} size
 * @param {number} scale
 * @param {{width: number, height: number}} work
 * @param {number} density
 */
function windowSize(size, scale, work, density) {
  const width = Math.round(size.width * scale / density);
  const height = Math.round(size.height * scale / density);
  const fits = width >= 160 && height >= 90 && width <= work.width && height <= work.height
    && size.width * scale <= 6144 && size.height * scale <= 3456;
  return { width, height, fits };
}
module.exports = { scales, windowSize };
