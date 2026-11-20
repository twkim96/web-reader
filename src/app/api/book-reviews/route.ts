import { getAdminFirestore } from '../../../server/firebaseAdmin';
import { isBookDetailId } from '../../../lib/bookDetail';
import { resolveSocialWork } from '../../../server/mypage/catalog';
import { workPublicReviews } from '../../../server/mypage/store';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const workId = new URL(request.url).searchParams.get('workId');
  if (!isBookDetailId(workId)) return Response.json({ error: 'invalid-work' }, { status: 400, headers });
  try {
    const db = getAdminFirestore();
    const work = await resolveSocialWork(db, workId);
    return Response.json(work ? await workPublicReviews(db, work.book.id, work.equivalentWorkIds)
      : { reviews: [], average: null, ratingCount: 0 }, { headers });
  } catch {
    return Response.json({ error: 'reviews-unavailable' }, { status: 503, headers });
  }
}
