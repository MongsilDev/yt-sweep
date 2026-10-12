// 판정 규칙과 응답 해석 검사. 실행은 node test/smoke.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classify } = require('../classifier.js');
const P = require('../parse.js');

const NOW = Date.UTC(2026, 9, 11);
const days = (n) => NOW - n * 864e5;
const recent = (n, every, len, title = '사연') => Array.from({ length: n }, (_, i) => ({ ageDays: i * every, lenMin: len, title }));

// 공식 AI 표시가 두 영상 모두에 있으면 그것만으로 대상
assert.equal(classify({ aiHit: 2, links: 3, desc: '', recent: [] }, NOW).target, true);
// 한 영상에만 있고 다른 신호가 없으면 대상 아님
assert.equal(classify({ aiHit: 1, links: 3, desc: '', recent: [] }, NOW).target, false);
// 채널 설명의 AI 고지
assert.equal(classify({ aiHit: 0, links: 1, desc: '본 영상은 AI 기술을 활용한 창작 사연입니다', recent: [] }, NOW).target, true);
// 저작권 문구와 각색 고지는 AI 고지로 보지 않음
assert.equal(classify({ aiHit: 0, links: 1, desc: '무단 전재, AI 학습 및 활용 금지', recent: [] }, NOW).why.includes('AI 고지'), false);
assert.equal(classify({ aiHit: 0, links: 1, desc: '사연은 일부 각색될 수 있습니다', recent: [] }, NOW).why.includes('AI 고지'), false);
// 1시간짜리를 하루 세 개씩 올리는 신생 채널
assert.equal(classify({ aiHit: 0, links: 0, joinedAt: days(60), videos: 180, subs: 5000, desc: '', recent: recent(30, 0.3, 80) }, NOW).target, true);
// 가입 5개월에 쇼츠 120개인 클립 양산 채널은 긴 영상이 없어도 대상
assert.equal(classify({ aiHit: 0, links: 0, joinedAt: days(150), videos: 120, subs: 30000, desc: '', recent: [] }, NOW).target, true);
// 영상이 적은 신생 채널과 몇 년째 꾸준히 올리는 채널은 대상 아님
assert.equal(classify({ aiHit: 0, links: 1, joinedAt: days(10), videos: 8, subs: 5000, desc: '', recent: [] }, NOW).target, false);
assert.equal(classify({ aiHit: 0, links: 2, joinedAt: days(1500), videos: 400, subs: 20000, desc: '', recent: [] }, NOW).target, false);
// 구독자 1000명 미만은 대상, 구독자 수를 숨긴 채널은 판단하지 않음
assert.equal(classify({ aiHit: 0, links: 1, subs: 3, videos: 4, desc: '', recent: [] }, NOW).why.includes('소형 채널'), true);
assert.equal(classify({ aiHit: 0, links: 1, subs: null, videos: 4, desc: '', recent: [] }, NOW).target, false);

// 롱폼 없이 쇼츠만 올리고 영상 설명에 본인 방송이나 문의처가 없는 채널
const shortsList = Array.from({ length: 20 }, (_, i) => ({ videoId: 's' + i, title: '반전 ' + i }));
const shortsOnly = { aiHit: 0, links: 1, subs: 30000, joinedAt: days(3000), videos: 200, desc: '', recent: [], shorts: shortsList };
assert.equal(classify({ ...shortsOnly, videoDescs: ['#shorts', ''] }, NOW).target, true);
assert.equal(classify({ ...shortsOnly, videoDescs: ['치지직 방송 매일 저녁 8시'] }, NOW).target, false);
// 영상 설명이 남의 핸들뿐이거나 출처 항목이면 대상, 자기 핸들이나 본인 방송 안내가 함께 있으면 아님
const longform = { aiHit: 0, links: 2, subs: 50000, joinedAt: days(3000), videos: 100, desc: '', recent: recent(10, 30, 10) };
assert.equal(classify({ ...longform, videoDescs: ['@someone.original'] }, NOW).why.includes('출처 표기'), true);
assert.equal(classify({ ...longform, handle: 'me', videoDescs: ['Credits : animation @me'] }, NOW).why.includes('출처 표기'), false);
assert.equal(classify({ ...longform, videoDescs: ['출처: incompetech.com\n치지직 방송 안내'] }, NOW).why.includes('출처 표기'), false);
// 오래된 채널도 링크와 운영자 정보 없이 하루 0.3개 넘게 쌓으면 대상
assert.equal(classify({ aiHit: 0, links: 0, subs: 55000, joinedAt: days(900), videos: 1700, desc: '', recent: recent(10, 1, 2), videoDescs: ['#야구'] }, NOW).target, true);
// 매일 올려도 채널 설명에 이메일이 있거나 영상 설명에 본인 방송 안내가 있으면 다작 점수 없음
assert.equal(classify({ aiHit: 0, links: 0, subs: 21000, joinedAt: days(2000), videos: 934, desc: '이메일 : me@gmail.com', recent: recent(10, 1, 1), videoDescs: ['#롤'] }, NOW).target, false);
assert.equal(classify({ aiHit: 0, links: 1, subs: 1800, joinedAt: days(1270), videos: 1003, desc: '', recent: recent(10, 1, 10), videoDescs: ['Twitch / me'] }, NOW).target, false);
// 자기 콘텐츠 보호 문구 속 AI, 원본 출처 언급은 고지로 보지 않음
assert.equal(classify({ aiHit: 0, links: 3, desc: '무단 모방 및 AI를 활용해 복제하는 행위는 위반입니다', recent: [] }, NOW).why.includes('AI 고지'), false);
assert.equal(classify({ aiHit: 0, links: 3, desc: '영상 내 원본 출처 표기 필수', recent: [] }, NOW).why.includes('재업로드 고지'), false);
// 남의 영상을 쓴다는 면책 문구는 대상, 자기 콘텐츠의 저작권 문의 문구는 아님
assert.equal(classify({ aiHit: 0, links: 2, joinedAt: days(2000), videos: 150, desc: '모든 영상에는 원본 출처를 표기합니다', recent: [] }, NOW).target, true);
assert.equal(classify({ aiHit: 0, links: 2, joinedAt: days(2000), videos: 150, desc: 'Fair Use 원칙에 따라 편집합니다', recent: [] }, NOW).target, true);
assert.equal(classify({ aiHit: 0, links: 2, joinedAt: days(2000), videos: 150, desc: '저작권 관련 문의는 메일로', recent: [] }, NOW).target, false);
// 같은 속도라도 오래된 대형 채널은 속도 점수 없음
const broadcaster = classify({ aiHit: 0, links: 6, joinedAt: days(4000), videos: 90000, subs: 4e6, desc: '', recent: recent(30, 0.05, 40) }, NOW);
assert.equal(broadcaster.target, false);
assert.equal(broadcaster.score, 0);
// 구독 중인 채널은 건너뜀
assert.equal(classify({ subscribed: true, aiHit: 2 }, NOW).skip, true);

// 홈 카드 lockupViewModel
const menu = (label, token, undo) => ({ listItemViewModel: { title: { content: label }, rendererContext: { commandContext: { onTap: { innertubeCommand: { feedbackEndpoint: { feedbackToken: token, actions: [{ replaceEnclosingAction: { item: { notificationMultiActionRenderer: { buttons: [{ buttonRenderer: { serviceEndpoint: { undoFeedbackEndpoint: { undoToken: undo } } } }] } } } }] } } } } } } });
const lockup = {
  lockupViewModel: {
    contentId: 'abcdefghijk', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', rendererContext: {},
    metadata: { lockupMetadataViewModel: { title: { content: '제목' }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: '채널명', commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCaaaaaaaaaaaaaaaaaaaaaa' } } } }] } }] }] } },
      menuButton: { sheet: { items: [menu('관심 없음', 'NI'), menu('채널 추천 안함', 'DR', 'UNDO')] } } } },
  },
};
const card = P.cardInfo({ content: lockup });
assert.deepEqual([card.videoId, card.channelId, card.channelName, card.isShort], ['abcdefghijk', 'UCaaaaaaaaaaaaaaaaaaaaaa', '채널명', false]);
assert.equal(card.notInterested.token, 'NI');
assert.deepEqual(card.dontRecommend, { token: 'DR', undo: 'UNDO' });

// 쇼츠 선반 카드는 채널 없이 영상 ID와 관심 없음만
const shorts = P.cardInfo({ content: { shortsLockupViewModel: { entityId: 'shorts-shelf-item-x', onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'shortvideo1' } } }, overlayMetadata: { primaryText: { content: '쇼츠' } }, menu: menu('관심 없음', 'NI2') } } });
assert.deepEqual([shorts.videoId, shorts.isShort, shorts.channelId, shorts.notInterested.token], ['shortvideo1', true, null, 'NI2']);

// 쇼츠 탭과 영상 설명
assert.deepEqual(P.shortsPage({ contents: { a: [{ shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'v1' } } }, overlayMetadata: { primaryText: { content: '제목' } } } }] } }), [{ videoId: 'v1', title: '제목' }]);
assert.equal(P.videoDesc({ x: { attributedDescription: { content: '게임명 : 레이븐2' } } }), '게임명 : 레이븐2');
assert.equal(P.channelAbout({ x: { aboutChannelViewModel: { description: '' } } }).subs, null);

// 쇼츠 응답은 채널과 그 쇼츠의 AI 표시를 함께 줌
const reel = P.reelInfo({ overlay: { c: { browseEndpoint: { browseId: 'UCbbbbbbbbbbbbbbbbbbbbbb' } } }, panels: { howThisWasMadeSectionViewModel: { t: { content: 'AI로 제작' } } }, menu: menu('채널 추천 안함', 'DR2') });
assert.deepEqual([reel.channelId, reel.aiLabeled, reel.dontRecommend.token], ['UCbbbbbbbbbbbbbbbbbbbbbb', true, 'DR2']);

// 광고 카드는 건너뜀
assert.equal(P.cardInfo({ content: { adSlotRenderer: {} } }), null);

// 채널 소개와 상대 시각
const about = P.channelAbout({ x: { aboutChannelViewModel: { joinedDateText: { content: '가입일: 2026. 9. 28.' }, description: 'd', links: [], canonicalChannelUrl: 'http://www.youtube.com/@%EB%82%98%EC%9D%98-l2d', subscriberCountText: '구독자 1.4만명', videoCountText: '동영상 45개' } } });
assert.equal(about.handle, '나의-l2d');
assert.equal(about.subs, 14000);
assert.equal(about.videos, 45);
assert.equal(new Date(about.joinedAt).getMonth(), 8);
assert.equal(P.relDays('3일 전'), 3);
assert.equal(P.relDays('2주 전'), 14);

// 콘텐츠 생성 방식 표시
assert.equal(P.aiLabeled({ a: { howThisWasMadeSectionViewModel: { t: { content: '사운드 또는 영상이 변경되었거나 새롭게 생성되었습니다.' } } } }), true);
assert.equal(P.aiLabeled({ a: { videoSummary: { content: 'AI 생성 동영상 요약' } } }), false);

console.log('ok');
