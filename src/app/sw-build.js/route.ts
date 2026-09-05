// An imported SW script participates in update detection even if sw.js is unchanged.
export const dynamic = 'force-static';

export function GET() {
  return new Response(`self.PC_READER_BUILD_ID = ${JSON.stringify(process.env.NEXT_PUBLIC_APP_BUILD_ID ?? 'development')};`, {
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
  });
}
