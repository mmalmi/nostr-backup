// Run inside open X and Instagram tabs with scripting.executeScript, so each is self-contained.
// They read only the signed-in account's own public profile.

/** The signed-in X account, from X's sidebar link to its profile. */
export function xProfileLink() {
  return document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') ?? null;
}

/** The signed-in Instagram account's username and public profile, from the page's viewer data. */
export function instagramViewer() {
  const find = (node: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(node)) {
      if (node[0] === 'PolarisViewer' && node[2]?.data) return node[2].data;
      for (const child of node) {
        const found = find(child);
        if (found) return found;
      }
    } else if (node && typeof node === 'object') {
      for (const value of Object.values(node)) {
        const found = find(value);
        if (found) return found;
      }
    }
  };
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    if (!script.textContent?.includes('PolarisViewer')) continue;
    try {
      const viewer = find(JSON.parse(script.textContent));
      if (typeof viewer?.username === 'string')
        return {
          username: viewer.username,
          name: viewer.full_name,
          about: viewer.biography,
          website: viewer.external_url,
          picture: viewer.profile_pic_url_hd || viewer.profile_pic_url,
        };
    } catch { /* Another data block. */ }
  }
  return null;
}
