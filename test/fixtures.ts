export function article(author: string, id: string, text: string | null = 'A post 🌲', extra = '') {
  return (
    '<article data-testid="tweet"><div data-testid="User-Name"><a role="link" href="/' +
    author +
    '/status/' +
    id +
    '"><time datetime="2024-01-02T03:04:05Z">Jan 2</time></a></div>' +
    (text == null ? '' : '<div data-testid="tweetText">' + text + '</div>') +
    extra +
    '</article>'
  );
}
export const profileHTML =
  '<a data-testid="AppTabBar_Profile_Link" href="/viewer">Profile</a>' +
  article('alice', '123', 'Hello<br>backup <img alt="🌲">') +
  article('bob', '456', 'Foreign content');

export function publicTweetHTML(author: string, id: string, text: string, time: number, media: object[] = [], fields: Record<string, unknown> = {}) {
  const result = {
    __typename: 'Tweet', rest_id: id,
    core: { user_results: { result: { core: { screen_name: author }, privacy: { protected: false } } } },
    details: { full_text: text, created_at_ms: time * 1000 }, media_entities2: media, ...fields,
  };
  const data = {data: {tweet_result_by_rest_id: {result}}};
  return '<script type="application/json">' + JSON.stringify(JSON.stringify(data)) + '</script>';
}

/** X's signed-out profile page: the profile result is embedded as an escaped JSON string. */
export function publicProfileHTML(handle: string, user: { name: string; bio?: string; avatar?: string; banner?: string; website?: string; links?: [string, string][] }) {
  const result = {
    __typename: 'User',
    core: { name: user.name, screen_name: handle },
    avatar: { image_url: user.avatar ?? 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png' },
    banner: { image_url: user.banner ?? '' },
    profile_bio: {
      description: user.bio ?? '',
      entities: {
        description: { urls: (user.links ?? []).map(([url, expanded_url]) => ({ url, expanded_url })) },
        ...(user.website ? { url: { urls: [{ url: 'https://t.co/site', expanded_url: user.website }] } } : {}),
      },
    },
  };
  // A partial result for the same account comes first, as on X.
  const partial = { __typename: 'User', core: { screen_name: handle }, profile_bio: { description: user.bio ?? '' } };
  const value = (data: object) => 'kind:"Result.Ok",value:' + JSON.stringify(JSON.stringify({ data: { user_result_by_screen_name: { result: data } } }));
  return '<html><body><script>' + value(partial) + ',' + value(result) + '</script></body></html>';
}
