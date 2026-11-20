import Link from 'next/link';
import { PeopleSearch } from '../../components/mypage/SocialPanels';

export default function Page() {
  return (
    <main className="mx-auto min-h-dvh max-w-3xl space-y-5 px-5 py-7 sm:px-8">
      <Link href="/#mypage" className="inline-block text-sm opacity-75 hover:opacity-100">내 마이페이지</Link>
      <PeopleSearch />
    </main>
  );
}
