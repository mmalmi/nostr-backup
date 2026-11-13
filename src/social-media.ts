export function isMetaMedia(value: string) {
  if (typeof value !== 'string' || value.length > 16384) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname);
  } catch { return false; }
}
