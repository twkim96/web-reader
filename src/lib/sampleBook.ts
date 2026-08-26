'use client';

import JSZip from 'jszip';
import type { Book } from '../types.ts';
import { saveBookCoverToLocalV14 } from './bookCoverCache.ts';
import { saveBookToLocalV5 } from './localDBV5.ts';
import { DEVICE_CONTENT_OWNER_KEY } from './ownerIdentity.ts';

export const SAMPLE_BOOK_ID = 'sample-aesop-tortoise-hare-ko-v1';
export const SAMPLE_BOOK_TITLE = '토끼와 거북이';
export const SAMPLE_BOOK_FILE_NAME = `${SAMPLE_BOOK_TITLE} — 이솝 우화.epub`;
export const SAMPLE_BOOK_MODIFIED_TIME = '2026-08-22T00:00:00.000Z';

interface SampleBookCoverTheme {
  label: string;
  skyStart: string;
  skyEnd: string;
  hillStart: string;
  hillEnd: string;
  foregroundHill: string;
  moon: string;
  moonCutout: string;
  primaryText: string;
  secondaryText: string;
  rabbit: string;
  turtle: string;
  turtleShell: string;
}

export interface SampleBookVariant {
  id: string;
  title: string;
  fileName: string;
  modifiedTime: string;
  coverTheme: SampleBookCoverTheme;
}

const createSampleBookVariant = (
  index: number,
  label: string,
  coverTheme: Omit<SampleBookCoverTheme, 'label'>,
): SampleBookVariant => {
  const title = index === 0 ? SAMPLE_BOOK_TITLE : `${SAMPLE_BOOK_TITLE} — ${label}`;
  return {
    id: index === 0 ? SAMPLE_BOOK_ID : `sample-aesop-tortoise-hare-ko-v${index + 1}`,
    title,
    fileName: index === 0 ? SAMPLE_BOOK_FILE_NAME : `${title} · 이솝 우화.epub`,
    modifiedTime: `2026-08-22T00:0${index}:00.000Z`,
    coverTheme: { label, ...coverTheme },
  };
};

export const SAMPLE_BOOK_VARIANTS: readonly SampleBookVariant[] = [
  createSampleBookVariant(0, '달빛', {
    skyStart: '#141517', skyEnd: '#283941', hillStart: '#46705d', hillEnd: '#203b34',
    foregroundHill: '#172b27', moon: '#f2dda0', moonCutout: '#1a2023', primaryText: '#ffffff',
    secondaryText: '#d2d3d6', rabbit: '#d2d3d6', turtle: '#87a56b', turtleShell: '#526f4d',
  }),
  createSampleBookVariant(1, '새벽', {
    skyStart: '#99C7E8', skyEnd: '#467377', hillStart: '#696843', hillEnd: '#4D4720',
    foregroundHill: '#31351f', moon: '#E8E899', moonCutout: '#778793', primaryText: '#141517',
    secondaryText: '#26363a', rabbit: '#f4f0e2', turtle: '#B3CACC', turtleShell: '#467377',
  }),
  createSampleBookVariant(2, '햇살', {
    skyStart: '#E8E899', skyEnd: '#CCC9B4', hillStart: '#467377', hillEnd: '#294f52',
    foregroundHill: '#233f42', moon: '#E89A99', moonCutout: '#CCC9B4', primaryText: '#141517',
    secondaryText: '#4D4720', rabbit: '#fffdf2', turtle: '#E8E899', turtleShell: '#696843',
  }),
  createSampleBookVariant(3, '장미', {
    skyStart: '#E89A99', skyEnd: '#CCB4C2', hillStart: '#696843', hillEnd: '#4D4720',
    foregroundHill: '#35351f', moon: '#E8E899', moonCutout: '#778793', primaryText: '#141517',
    secondaryText: '#4D4720', rabbit: '#fff7f0', turtle: '#B3CACC', turtleShell: '#467377',
  }),
  createSampleBookVariant(4, '안개', {
    skyStart: '#B3CACC', skyEnd: '#778793', hillStart: '#696843', hillEnd: '#4D4720',
    foregroundHill: '#363921', moon: '#CCC9B4', moonCutout: '#467377', primaryText: '#141517',
    secondaryText: '#293b3e', rabbit: '#f7f5ec', turtle: '#E8E899', turtleShell: '#696843',
  }),
  createSampleBookVariant(5, '라일락', {
    skyStart: '#CCB4C2', skyEnd: '#778793', hillStart: '#467377', hillEnd: '#294f52',
    foregroundHill: '#233f42', moon: '#E8E899', moonCutout: '#696843', primaryText: '#141517',
    secondaryText: '#4D4720', rabbit: '#fff9f5', turtle: '#E89A99', turtleShell: '#4D4720',
  }),
  createSampleBookVariant(6, '노을', {
    skyStart: '#CCC9B4', skyEnd: '#E89A99', hillStart: '#778793', hillEnd: '#467377',
    foregroundHill: '#324f52', moon: '#E8E899', moonCutout: '#4D4720', primaryText: '#141517',
    secondaryText: '#4D4720', rabbit: '#f7f3e8', turtle: '#E8E899', turtleShell: '#696843',
  }),
  createSampleBookVariant(7, '숲', {
    skyStart: '#467377', skyEnd: '#4D4720', hillStart: '#99C7E8', hillEnd: '#778793',
    foregroundHill: '#364b50', moon: '#E8E899', moonCutout: '#141517', primaryText: '#ffffff',
    secondaryText: '#e7e5dc', rabbit: '#f6f2e8', turtle: '#CCB4C2', turtleShell: '#696843',
  }),
] as const;

const EPUB_MIME = 'application/epub+zip';
const COVER_MIME = 'image/svg+xml';

const escapeXml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const paragraphs = (items: readonly string[]) => items
  .map((item) => `<p>${escapeXml(item)}</p>`)
  .join('\n');

const chapters = [
  {
    id: 'challenge',
    title: '1. 뜻밖의 경주',
    body: [
      '숲 가장자리의 넓은 풀밭에는 달리기가 빠른 토끼와 묵묵히 걷는 거북이가 살고 있었습니다.',
      '봄이 오면 풀밭에는 민들레가 피었고, 여름이면 키 큰 풀이 바람을 따라 물결쳤습니다. 동물들은 아침마다 그 길을 지나 샘터와 열매나무로 향했습니다.',
      '토끼는 누구보다 먼저 샘터에 도착했고, 가장 높은 언덕도 단숨에 올랐습니다. 빠른 발은 토끼가 가장 자랑스러워하는 재주였습니다.',
      '토끼는 바람보다 빨리 언덕을 오를 수 있다며 자랑하곤 했습니다. 어느 날에는 천천히 길을 건너는 거북이를 보고 큰 소리로 웃었습니다.',
      '“네가 샘터에 도착할 때쯤이면 나는 벌써 점심을 먹고 낮잠까지 자겠어.” 토끼는 기다란 귀를 흔들며 제자리에서 가볍게 뛰었습니다.',
      '주변에 있던 다람쥐와 고슴도치는 거북이가 속상할까 걱정했습니다. 하지만 거북이는 숨을 고른 뒤 토끼를 똑바로 바라보았습니다.',
      '거북이는 화를 내는 대신 조용히 말했습니다. “빠른 발도 훌륭하지만, 끝까지 걷는 마음도 훌륭해. 우리 저 너머 느티나무까지 가 볼까?”',
      '토끼는 처음에는 잘못 들은 줄 알았습니다. 느티나무는 풀밭과 개울, 돌언덕을 모두 지나야 만날 수 있는 아주 먼 곳이었기 때문입니다.',
      '“정말 나와 경주하겠다고?” 토끼가 되묻자 거북이는 고개를 끄덕였습니다. 말은 짧았지만 눈빛은 조금도 흔들리지 않았습니다.',
      '소문은 금세 숲 전체로 퍼졌습니다. 까치는 높은 나뭇가지에서 경주 소식을 외쳤고, 두더지는 안전한 길을 확인하러 땅 위로 올라왔습니다.',
      '부엉이는 출발과 도착을 살필 심판을 맡았습니다. 여우는 길목마다 작은 깃발을 세워 누구도 지름길로 빠지지 않게 했습니다.',
      '경주 전날 거북이는 평소처럼 풀밭을 걸었습니다. 특별히 빨리 움직이지 않고 돌의 위치와 개울가의 미끄러운 흙을 차분히 기억했습니다.',
      '토끼는 연습이 필요 없다며 친구들과 늦게까지 놀았습니다. 몇 번 크게 뛰어 보인 뒤 “이 정도면 충분해”라고 말했습니다.',
      '경주 날 아침은 맑았습니다. 밤새 내린 이슬이 풀잎 끝에서 반짝였고, 멀리 있는 느티나무 꼭대기가 햇빛을 받아 환하게 빛났습니다.',
      '거북이는 출발선 앞에서 다리와 목을 천천히 움직였습니다. 오늘 해야 할 일은 단 하나, 정해 둔 길을 끝까지 걷는 것이었습니다.',
      '토끼는 가볍게 몸을 풀고 관중에게 손을 흔들었습니다. 벌써 승리한 것처럼 웃었지만 부엉이는 두 선수가 나란히 설 때까지 기다렸습니다.',
      '숲의 동물들이 출발선을 만들었습니다. 부엉이가 날개를 들었다 내리자 경주가 시작되었습니다.',
      '토끼의 뒷발이 땅을 박차자 마른 흙이 작은 구름처럼 솟았습니다. 거북이도 같은 순간에 오른발을 내디뎠습니다.',
      '몇 걸음 만에 둘의 거리는 크게 벌어졌습니다. 그래도 거북이는 토끼의 뒷모습 대신 바로 앞에 놓인 다음 돌을 바라보았습니다.',
      '첫 번째 깃발을 지난 거북이는 속으로 짧게 말했습니다. “한 걸음씩 가면 길은 반드시 줄어든다.” 그렇게 긴 하루가 시작되었습니다.',
    ],
  },
  {
    id: 'road',
    title: '2. 서로 다른 걸음',
    body: [
      '토끼는 흙먼지를 일으키며 순식간에 멀어졌습니다. 뒤를 돌아보니 거북이는 작은 점처럼 보였습니다.',
      '첫 번째 풀밭은 토끼에게 너무 쉬웠습니다. 낮은 풀을 뛰어넘을 때마다 몸이 가벼워져 마치 하늘을 나는 듯했습니다.',
      '개울 앞에서도 토끼는 멈추지 않았습니다. 물 위로 드러난 세 개의 돌을 차례로 밟아 한 번에 반대편으로 건너갔습니다.',
      '거북이는 개울가에 도착해 가장 넓고 평평한 돌을 골랐습니다. 물살을 살피고 발을 단단히 붙인 뒤 천천히 건넜습니다.',
      '중간 돌에서 차가운 물방울이 등딱지에 튀었지만 거북이는 놀라지 않았습니다. 미끄러지지 않는 것이 빨리 건너는 것보다 중요했습니다.',
      '거북이는 서두르지 않았습니다. 돌부리를 하나 넘고, 풀잎 사이의 좁은 길을 지나고, 다시 앞발을 내디뎠습니다.',
      '길가에서 응원하던 개구리가 “조금만 더 빨리 가 봐!”라고 외쳤습니다. 거북이는 웃으며 “내가 끝까지 갈 수 있는 속도가 가장 좋은 속도야”라고 답했습니다.',
      '돌언덕에 이르자 길은 가팔라졌습니다. 거북이는 발을 높이 들 때마다 숨을 길게 내쉬고, 평평한 곳에서는 호흡을 다시 가다듬었습니다.',
      '한편 토끼는 언덕 꼭대기에 벌써 도착해 있었습니다. 아래를 내려다봐도 거북이는 나무와 풀에 가려 보이지 않았습니다.',
      '토끼는 승부가 너무 싱겁다고 생각했습니다. 혼자 달리는 것 같아 심심해진 토끼는 길가의 산딸기를 몇 알 따 먹었습니다.',
      '산딸기를 먹고도 시간이 남자 토끼는 나비를 따라 잠시 옆길을 뛰었습니다. 여우가 세운 깃발을 보고서야 다시 경주 길로 돌아왔습니다.',
      '그래도 거북이는 아직 멀리 있었습니다. 토끼는 남은 거리를 세어 보고는 아무리 쉬어도 질 수 없다고 판단했습니다.',
      '한참 앞선 토끼는 커다란 나무 그늘을 발견했습니다. “잠깐 쉬어도 넉넉하겠지.” 토끼는 부드러운 풀 위에 누웠습니다.',
      '나무 아래에는 마른 잎이 포근하게 쌓여 있었습니다. 토끼는 눈을 감지 않겠다고 다짐하며 두 귀를 세운 채 하늘만 바라보았습니다.',
      '바람은 시원했고 나뭇잎 소리는 자장가 같았습니다. 토끼의 눈은 곧 감겼습니다.',
      '처음에는 새소리도 또렷하게 들렸지만 잠이 깊어지자 모든 소리가 멀어졌습니다. 토끼의 귀도 천천히 옆으로 기울었습니다.',
      '거북이는 돌언덕을 내려와 다시 평평한 길에 들어섰습니다. 발바닥이 뻐근했지만 지나온 깃발을 돌아보지 않았습니다.',
      '작은 구름이 해를 가려 주자 길 위의 열기가 잠시 식었습니다. 거북이는 그 짧은 그늘을 선물처럼 여기며 계속 걸었습니다.',
      '마침내 거북이 앞에 토끼가 쉬고 있는 큰 나무가 보였습니다. 가까이 다가가자 규칙적인 숨소리까지 들렸습니다.',
      '거북이는 토끼를 깨울지 잠시 고민했습니다. 그러나 경주는 서로 약속한 일이었고, 각자의 선택도 스스로 책임져야 한다고 생각했습니다.',
      '거북이는 발소리를 줄이려 애쓰지 않았고, 일부러 크게 내지도 않았습니다. 평소와 같은 걸음으로 나무 그늘을 지나 다음 깃발을 향했습니다.',
    ],
  },
  {
    id: 'finish',
    title: '3. 느티나무 아래에서',
    body: [
      '거북이는 잠든 토끼 곁을 지나면서도 걸음을 멈추지 않았습니다. 숨이 찰 때에는 한 번 크게 숨을 쉬고 다시 걸었습니다.',
      '큰 나무 뒤의 길은 생각보다 길었습니다. 낮은 언덕이 두 번 이어졌고, 언덕 사이에는 바퀴 자국처럼 움푹 팬 흙길이 놓여 있었습니다.',
      '거북이는 움푹 팬 곳을 피해 가장자리로 걸었습니다. 조금 돌아가더라도 발이 빠지지 않는 길이 결국 더 빠르다는 것을 알고 있었습니다.',
      '도착점의 느티나무는 아직 작게 보였습니다. 거북이는 나무 전체를 바라보면 마음이 조급해져서 다음 깃발까지만 생각하기로 했습니다.',
      '한 깃발에 닿으면 잠깐 숨을 고르고 곧 다음 깃발을 찾았습니다. 먼 목표는 그렇게 여러 개의 가까운 목표로 나뉘었습니다.',
      '응원하던 동물들도 처음보다 조용해졌습니다. 모두 거북이의 일정한 발소리에 귀를 기울이며 함께 길을 세는 기분이 들었습니다.',
      '다람쥐는 나뭇가지 사이로 먼저 달려가 도착점의 소식을 전했습니다. 부엉이는 느티나무 아래에서 결승선을 다시 반듯하게 정리했습니다.',
      '해가 조금 기울었을 때 거북이는 마침내 느티나무 앞의 마지막 오솔길에 닿았습니다.',
      '마지막 오솔길은 부드러운 흙길이었지만 거북이에게는 가장 힘든 구간이었습니다. 긴 시간 움직인 다리가 무겁고 목도 말랐습니다.',
      '거북이는 잠깐 멈춰 깊게 숨을 들이마셨습니다. 쉬는 것과 포기하는 것은 다르다는 것을 알았기에, 숨이 고르게 되자 다시 움직였습니다.',
      '그 무렵 나무 그늘의 햇빛이 토끼의 얼굴까지 옮겨 왔습니다. 따뜻한 빛에 코를 찡그린 토끼가 눈을 떴습니다.',
      '처음에는 얼마나 잤는지 알 수 없었습니다. 하지만 멀리서 들리는 응원 소리와 기울어진 해를 보자 토끼의 심장이 세차게 뛰었습니다.',
      '그제야 잠에서 깬 토끼가 깜짝 놀라 달리기 시작했습니다. 하지만 거북이는 이미 느티나무에 앞발을 대고 있었습니다.',
      '토끼는 지금까지 달린 어느 때보다 빠르게 뛰었습니다. 돌을 넘고 굽은 길을 돌아 느티나무를 향했지만, 결승선에서는 이미 환호가 터지고 있었습니다.',
      '거북이는 결승선을 지난 뒤에도 몇 걸음을 더 걸어 안전한 곳에서 멈췄습니다. 그리고 뒤늦게 도착한 토끼를 향해 조용히 고개를 숙였습니다.',
      '동물들은 거북이의 꾸준한 걸음에 박수를 보냈습니다. 토끼도 고개를 숙이고 거북이에게 축하를 건넸습니다.',
      '토끼는 변명하고 싶은 마음이 잠깐 들었습니다. 하지만 늦잠도, 지나친 자신감도 모두 자신의 선택이었다는 사실을 인정했습니다.',
      '“네가 운이 좋아서 이긴 게 아니야. 너는 내가 쉬는 동안에도 계속 걸었어.” 토끼가 말하자 거북이는 따뜻하게 웃었습니다.',
      '부엉이는 승자를 알리면서도 두 선수 모두 약속한 길을 완주했다고 말했습니다. 관중은 토끼에게도 끝까지 달려온 박수를 보냈습니다.',
      '토끼는 패배가 부끄럽기만 한 일은 아니라는 것을 처음 알았습니다. 잘못을 제대로 바라보면 다음 선택을 바꿀 수 있기 때문입니다.',
      '느티나무의 긴 그림자가 두 선수의 발밑에서 나란히 겹쳤습니다. 아침에 시작된 경주는 그렇게 해가 기울 무렵 끝났습니다.',
    ],
  },
  {
    id: 'lesson',
    title: '4. 오래 남은 약속',
    body: [
      '거북이는 말했습니다. “오늘 이긴 것은 내 발이 아니라 멈추지 않은 마음이야.”',
      '토끼는 그 말을 오래 생각했습니다. 빠른 발만 믿고 해야 할 일을 미룬 순간들이 하나씩 떠올랐습니다.',
      '토끼는 빠른 재주를 함부로 자랑하지 않기로 했습니다. 거북이도 토끼의 빠른 발을 진심으로 칭찬했습니다.',
      '다음 날 토끼는 거북이의 집을 찾아가 함께 산책하자고 말했습니다. 이번에는 누가 먼저 도착하는지 정하지 않은 산책이었습니다.',
      '처음 며칠 동안 토끼는 자꾸 앞서갔습니다. 그럴 때마다 멈춰 주변을 살피고 거북이가 보일 때까지 기다렸습니다.',
      '기다리는 동안 토끼는 전에는 지나쳤던 것들을 발견했습니다. 나무껍질의 작은 무늬와 풀잎 아래의 이슬, 멀리서 흐르는 물소리였습니다.',
      '거북이도 토끼에게서 배웠습니다. 비가 오기 전 구름을 발견하면 머뭇거리기보다 안전한 굴까지 조금 빠르게 움직였습니다.',
      '둘은 서로 다른 속도가 잘못된 것이 아니라는 사실을 알게 되었습니다. 중요한 것은 목적과 상황에 맞게 재주를 사용하는 일이었습니다.',
      '그 뒤로 둘은 종종 함께 숲길을 걸었습니다. 토끼는 앞서가면 기다렸고, 거북이는 쉬지 않고 약속한 곳까지 갔습니다.',
      '어느 날 폭우가 내려 개울물이 갑자기 불어났습니다. 토끼는 빠르게 높은 곳을 찾아 친구들에게 알렸고, 거북이는 안전한 우회로를 차분히 안내했습니다.',
      '또 어느 날에는 어린 다람쥐가 숲길을 잃었습니다. 토끼는 넓은 지역을 빠르게 살폈고, 거북이는 작은 발자국을 놓치지 않고 따라갔습니다.',
      '둘이 힘을 합치자 혼자일 때보다 더 많은 일을 할 수 있었습니다. 빠름과 꾸준함은 서로 겨루는 재주가 아니라 함께 쓸 수 있는 힘이었습니다.',
      '토끼는 새로운 일을 시작할 때 가장 먼저 계획을 세웠습니다. 어디까지 달리고 언제 쉬어야 하는지 정하면 빠른 발을 끝까지 사용할 수 있었습니다.',
      '거북이는 힘든 길에서 잠깐 쉬는 것도 배웠습니다. 무조건 참는 대신 몸의 신호를 살피면 더 오래 꾸준히 갈 수 있었습니다.',
      '숲의 어린 동물들은 두 친구에게 경주 이야기를 자주 물었습니다. 토끼는 자신의 낮잠을 숨기지 않았고, 거북이도 힘들었던 순간을 솔직히 들려주었습니다.',
      '이야기를 들은 동물들은 결과만 기억하지 않았습니다. 큰 목표를 작은 걸음으로 나누는 법과 자신의 재주를 지나치게 믿지 않는 법을 배웠습니다.',
      '계절이 바뀌어 느티나무 잎이 붉게 물들었을 때 둘은 다시 결승선이 있던 곳을 찾았습니다. 땅의 줄은 사라졌지만 그날의 약속은 남아 있었습니다.',
      '토끼는 이번에는 천천히 나무 둘레를 돌았고, 거북이는 마지막 구간에서 힘차게 걸음을 높였습니다. 둘은 동시에 웃으며 나무줄기에 손과 앞발을 댔습니다.',
      '누가 이겼는지는 중요하지 않았습니다. 서로의 속도를 이해한 두 친구가 같은 곳에 함께 도착했다는 사실이 더 기뻤습니다.',
      '빠름은 멋진 재주이지만, 꾸준함은 그 재주를 끝까지 데려가는 힘입니다.',
      '그리고 서로 다른 재주를 존중하는 마음은 혼자서는 갈 수 없던 더 먼 길까지 친구들을 데려갑니다.',
    ],
  },
] as const;

const createSampleBookCoverSvg = (variant: SampleBookVariant) => {
  const theme = variant.coverTheme;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(variant.title)} 표지</title>
  <desc id="desc">달빛 아래 언덕을 함께 바라보는 토끼와 거북이</desc>
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${theme.skyStart}"/>
      <stop offset="1" stop-color="${theme.skyEnd}"/>
    </linearGradient>
    <linearGradient id="hill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${theme.hillStart}"/>
      <stop offset="1" stop-color="${theme.hillEnd}"/>
    </linearGradient>
  </defs>
  <rect width="480" height="720" rx="28" fill="url(#sky)"/>
  <circle cx="374" cy="112" r="56" fill="${theme.moon}" opacity=".95"/>
  <circle cx="392" cy="96" r="56" fill="${theme.moonCutout}"/>
  <path d="M0 450 Q130 360 260 438 T480 410 V720 H0Z" fill="url(#hill)"/>
  <path d="M0 532 Q160 452 316 522 T480 486 V720 H0Z" fill="${theme.foregroundHill}"/>
  <g transform="translate(96 424)" fill="${theme.rabbit}">
    <ellipse cx="52" cy="58" rx="44" ry="29"/>
    <circle cx="91" cy="35" r="22"/>
    <ellipse cx="94" cy="5" rx="8" ry="30" transform="rotate(-10 94 5)"/>
    <ellipse cx="111" cy="8" rx="8" ry="31" transform="rotate(8 111 8)"/>
    <circle cx="98" cy="31" r="3" fill="${theme.moonCutout}"/>
  </g>
  <g transform="translate(280 480)">
    <ellipse cx="56" cy="44" rx="54" ry="34" fill="${theme.turtle}"/>
    <path d="M18 44 Q56 4 94 44 Q56 78 18 44Z" fill="${theme.turtleShell}"/>
    <path d="M36 25 L76 63 M76 25 L36 63" stroke="${theme.turtle}" stroke-width="6" opacity=".7"/>
    <circle cx="112" cy="43" r="19" fill="${theme.turtle}"/>
    <circle cx="118" cy="38" r="3" fill="${theme.moonCutout}"/>
  </g>
  <text x="48" y="122" fill="${theme.secondaryText}" font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif" font-size="21" font-weight="700" letter-spacing="3">이솝 우화 · ${escapeXml(theme.label)}</text>
  <text x="48" y="188" fill="${theme.primaryText}" font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif" font-size="48" font-weight="800">토끼와</text>
  <text x="48" y="246" fill="${theme.primaryText}" font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif" font-size="48" font-weight="800">거북이</text>
  <text x="48" y="668" fill="${theme.secondaryText}" opacity=".82" font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif" font-size="16">WEB READER SAMPLE · ${escapeXml(theme.label)}</text>
</svg>`;
};

export const createSampleBookCover = (variant: SampleBookVariant = SAMPLE_BOOK_VARIANTS[0]) => (
  new Blob([createSampleBookCoverSvg(variant)], { type: COVER_MIME })
);

const chapterXhtml = (title: string, body: readonly string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko" lang="ko">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  ${paragraphs(body)}
</body>
</html>`;

export const createSampleBookPackage = async (variant: SampleBookVariant = SAMPLE_BOOK_VARIANTS[0]) => {
  const coverSvg = createSampleBookCoverSvg(variant);
  const cover = new Blob([coverSvg], { type: COVER_MIME });
  const zip = new JSZip();
  zip.file('mimetype', EPUB_MIME, { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file('OEBPS/cover.svg', coverSvg);
  zip.file('OEBPS/style.css', `body{margin:0 auto;padding:7vh 8vw;max-width:42rem;font-family:serif;line-height:1.9;word-break:normal;line-break:strict;overflow-wrap:anywhere}h1{font-size:1.55em;margin:0 0 2.4em}p{margin:0 0 1.25em}small{opacity:.72}`);
  zip.file('OEBPS/cover.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko" lang="ko"><head><title>표지</title><meta name="viewport" content="width=480,height=720"/></head><body style="margin:0"><img src="cover.svg" alt="${escapeXml(variant.title)} 표지" style="display:block;width:100%;height:auto"/></body></html>`);
  for (const chapter of chapters) {
    zip.file(`OEBPS/${chapter.id}.xhtml`, chapterXhtml(chapter.title, chapter.body));
  }
  zip.file('OEBPS/about.xhtml', chapterXhtml('샘플 도서 안내', [
    '이 책은 앱의 로컬 도서·표지·목차 기능을 체험하기 위한 Web Reader 샘플입니다.',
    '이솝 우화 원전은 퍼블릭 도메인입니다. 이 샘플의 한국어 문안과 SVG 표지는 원문 번역을 복제하지 않고 새로 제작했으며 CC0로 제공합니다.',
    '출처 확인: Project Gutenberg, Aesop’s Fables, eBook 11339.',
  ]));

  const manifest = chapters.map((chapter) => `    <item id="${chapter.id}" href="${chapter.id}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
  const spine = chapters.map((chapter) => `    <itemref idref="${chapter.id}"/>`).join('\n');
  const navItems = chapters.map((chapter) => `      <li><a href="${chapter.id}.xhtml">${escapeXml(chapter.title)}</a></li>`).join('\n');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ko">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:web-reader:${variant.id}</dc:identifier>
    <dc:title>${escapeXml(variant.title)}</dc:title>
    <dc:creator id="creator">이솝 (Aesop)</dc:creator>
    <dc:language>ko</dc:language>
    <dc:publisher>Web Reader</dc:publisher>
    <dc:subject>동화</dc:subject><dc:subject>우화</dc:subject><dc:subject>퍼블릭 도메인</dc:subject>
    <dc:description>빠른 토끼와 꾸준한 거북이가 함께 배우는 이솝 우화 샘플</dc:description>
    <dc:rights>Public domain source; Web Reader Korean adaptation and cover dedicated to CC0.</dc:rights>
    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>
    <meta property="dcterms:modified">${variant.modifiedTime.replace('.000Z', 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest}
    <item id="about" href="about.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
${spine}
    <itemref idref="about"/>
  </spine>
</package>`);
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko"><head><title>목차</title></head><body><nav epub:type="toc" id="toc"><h1>목차</h1><ol>
${navItems}
      <li><a href="about.xhtml">샘플 도서 안내</a></li>
    </ol></nav></body></html>`);

  const content = await zip.generateAsync({
    type: 'blob',
    mimeType: EPUB_MIME,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const book: Book = {
    id: variant.id,
    name: variant.fileName,
    mimeType: EPUB_MIME,
    size: content.size,
    source: 'local',
    sourceFormat: 'epub',
    readerFormat: 'epub',
    modifiedTime: variant.modifiedTime,
  };
  return { book, content, cover };
};

export const installSampleBook = async (variant: SampleBookVariant = SAMPLE_BOOK_VARIANTS[0]) => {
  const sample = await createSampleBookPackage(variant);
  await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, sample.book, sample.content);
  await saveBookCoverToLocalV14(DEVICE_CONTENT_OWNER_KEY, sample.book, sample.cover);
  return sample.book;
};

export const installSampleBooks = async () => {
  const books: Book[] = [];
  for (const variant of SAMPLE_BOOK_VARIANTS) {
    books.push(await installSampleBook(variant));
  }
  return books;
};
