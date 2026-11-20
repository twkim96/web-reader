import { notFound } from 'next/navigation';
import { PublicReaderPage } from '../../../components/mypage/PublicReaderPage';
import { MY_PAGE_CODE } from '../../../lib/myPageSocial';

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  if (!MY_PAGE_CODE.test(code)) notFound();
  return <PublicReaderPage key={code} code={code} />;
}
