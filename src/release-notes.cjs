/** Present release notes as plain text in a native dialog; never execute markup.
 * @param {unknown} notes */
function plainReleaseNotes(notes) {
  if (typeof notes !== 'string') return '';
  const section = notes.split("## What's changed")[1];
  const text = section === undefined ? notes : section.split(/\n## /)[0];
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 16000);
}
module.exports = { plainReleaseNotes };
