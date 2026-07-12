const fixtureSource = `
self.addEventListener('install', () => {});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
`;

export const dynamic = 'force-dynamic';

export const GET = () => {
  if (process.env.NODE_ENV !== 'development') {
    return new Response(null, { status: 404 });
  }
  return new Response(fixtureSource, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/javascript; charset=utf-8',
    },
  });
};
