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

export function publicTweetHTML(author: string, id: string, text: string, time: number, media: object[] = []) {
  const result = {
    __typename: 'Tweet', rest_id: id,
    core: { user_results: { result: { core: { screen_name: author }, privacy: { protected: false } } } },
    details: { full_text: text, created_at_ms: time * 1000 }, media_entities2: media,
  };
  const data = {data: {tweet_result_by_rest_id: {result}}};
  return '<script type="application/json">' + JSON.stringify(JSON.stringify(data)) + '</script>';
}
