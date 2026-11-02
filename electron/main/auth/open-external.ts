export function isAllowedExternalUrl(url: string, options: { packaged: boolean }): boolean {
  if (url.length > 2048 || /[\u0000-\u001f\u007f]/u.test(url) || url.includes('\\') || url.startsWith('//')) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.protocol === 'https:') return true;
  return !options.packaged && parsed.protocol === 'http:';
}
