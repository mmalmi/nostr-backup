export function article(author, id, text = 'A post 🌲', extra = '') {
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
  '<a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a>' +
  article('alice', '123', 'Hello<br>backup <img alt="🌲">') +
  article('bob', '456', 'Foreign content');
