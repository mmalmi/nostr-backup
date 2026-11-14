export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' || url.hostname === 'backup.iris.to') {
      url.protocol = 'https:';
      url.host = 'socialbackup.org';
      return Response.redirect(url.href, 308);
    }
    return env.ASSETS.fetch(request);
  },
};
