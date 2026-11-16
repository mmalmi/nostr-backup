// Injected into already-open tabs. Each function must be self-contained.

/** The signed-in X account, from X's sidebar link to its profile, or else its account switcher's avatar. */
export function xProfileLink() {
  const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
  if (link) return link;
  const avatar = document
    .querySelector('[data-testid="SideNav_AccountSwitcher_Button"] [data-testid^="UserAvatar-Container-"]')
    ?.getAttribute('data-testid');
  return avatar ? '/' + avatar.slice('UserAvatar-Container-'.length) : null;
}

/** The signed-in Instagram account's username and public profile, from the page's viewer data. */
export function instagramViewer(includeProfile = true) {
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
      if (typeof viewer?.username === 'string') {
        if (!includeProfile) return { username: viewer.username };
        return {
          username: viewer.username,
          name: viewer.full_name,
          about: viewer.biography,
          website: viewer.external_url,
          picture: viewer.profile_pic_url_hd || viewer.profile_pic_url,
        };
      }
    } catch { /* Another data block. */ }
  }
  return null;
}

/** Facebook's current actor, including when the open tab shows somebody else's profile. */
export function facebookViewer() {
  const find = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node) && node[0] === 'CurrentUserInitialData') {
      const id = node[2]?.USER_ID;
      return typeof id === 'string' && /^[1-9]\d{0,24}$/.test(id) ? id : undefined;
    }
    for (const child of Object.values(node)) {
      const id = find(child);
      if (id) return id;
    }
  };
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    const json = script.textContent;
    if (!json?.includes('"CurrentUserInitialData"')) continue;
    try {
      const id = find(JSON.parse(json));
      if (id) return id;
    } catch { /* Incomplete page data. */ }
  }
  // The profile header's own Edit profile control also identifies a signed-in owner.
  const edit = document.querySelector<HTMLAnchorElement>(
    '[role="main"] a[aria-label="Edit profile"][href*="fb_profile_edit_entry_point"]',
  );
  if (!edit || edit.closest('[role="article"], [data-virtualized]')) return null;
  try {
    const url = new URL(edit.href);
    const entry = JSON.parse(url.searchParams.get('fb_profile_edit_entry_point') ?? 'null');
    const id = url.searchParams.get('id') ?? '';
    if (url.origin === document.location.origin && url.pathname === '/profile.php' &&
        entry?.feature === 'profile_header' && entry.click_point === 'edit_profile_button' &&
        /^[1-9]\d{0,24}$/.test(id)) return id;
  } catch { /* No usable owner control. */ }
  return null;
}
