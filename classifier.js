// 채널 수치로 사람이 만들지 않은 양산 채널 점수 계산. 외부 요청 없는 순수 함수라 브라우저와 node 공용
(function (root) {
  const RX = {
    // AI 학습 금지 같은 저작권 문구와 각색, 창작은 사람 채널에도 흔해 제외
    disclosure: /AI\s*(기술|도구|툴|음성|목소리|나레이션|내레이션|더빙|성우)?\s*(을|를|로|으로)?\s*(활용|이용|사용|제작|생성)|AI로\s*(제작|생성|만든)|(AI|인공지능)\s*(음성|목소리|나레이션|내레이션|더빙)|음성\s*생성|TTS|인공지능(을|으로)\s*(활용|이용|사용)|생성형\s*AI/i,
    notDisclosure: /AI\s*학습/i,
    autoHandle: /-[a-z0-9]{3}$/,
    // 남의 영상을 잘라 올리는 채널의 면책 문구. 자기 콘텐츠를 지키는 저작권 문의 문구는 제외
    reuse: /원본\s*출처|저작권은?\s*(각\s*)?(원\s*)?(저작권자|권리자|원작자|제작사)에게|fair\s*use|공정\s*(이용|사용)|저작권자\s*(의\s*)?요청\s*시|copyright\s*disclaimer|문제\s*(가\s*)?(될|되면|시)\s*.{0,10}삭제/i,
    // 영상 설명 전체가 남의 핸들이거나 출처 항목이 있는 형식
    credit: /^\s*(@[\w.\-가-힣]+[\s,]*)+$/,
    creditLine: /(^|\n)\s*(영상\s*|원본\s*)?(출처|source|credit)s?\s*[:：]/i,
    // 영상 설명의 본인 방송, 연락처, 판매처. 있으면 사람이 운영하는 채널로 봄
    // 자기 콘텐츠를 지키는 문장. 이 줄에 걸린 AI, 출처 문구는 고지로 보지 않음
    protect: /무단|금지|금합|법적|위반|불가|필수|간주|퍼가/,
    affiliate: /link\.coupang\.com|쿠팡\s*파트너스/i,
    self: /치지직|chzzk|twitch|트위치|아프리카|soop|멤버십|membership|instagram|인스타|discord|디스코드|비즈니스|business|문의|협찬|광고|후원|스토어|store|구매/i,
  };
  const SMALL_SUBS = 1000;

  // channel: { subscribed, subs, videos, joinedAt, desc, links, handle, recent, shorts, videoDescs, aiHit, aiChecked }
  function classify(ch, now) {
    if (ch.subscribed) return { score: 0, why: ['구독 중'], target: false, skip: true };

    let score = 0;
    const why = [];
    const add = (points, reason) => { score += points; why.push(reason); };

    if (ch.aiHit >= 2) add(6, '공식 AI 표시');
    else if (ch.aiHit === 1) add(3, 'AI 표시 일부');

    const lines = (ch.desc || '').split('\n').filter((l) => !RX.protect.test(l));
    const disclosed = lines.map((l) => l.match(RX.disclosure)).find((m) => m && !RX.notDisclosure.test(m[0]));
    if (disclosed) add(6, 'AI 고지');
    if (lines.some((l) => RX.reuse.test(l))) add(6, '재업로드 고지');

    const videoDescs = ch.videoDescs || [];
    const handle = (ch.handle || '').toLowerCase();
    const selfInDesc = videoDescs.some((d) => RX.self.test(d));
    const credited = videoDescs.some((d) => (RX.credit.test(d) || RX.creditLine.test(d)) && !(handle && d.toLowerCase().includes('@' + handle)));
    if (credited && !selfInDesc) add(6, '출처 표기');
    if ([ch.desc || '', ...videoDescs].some((d) => RX.affiliate.test(d))) add(4, '쿠팡 파트너스');

    if (ch.subs != null && ch.subs < SMALL_SUBS) add(6, '소형 채널');
    else if (ch.subs != null && ch.subs < SMALL_SUBS * 5) add(2, '구독자 적음');

    const shortsOnly = !(ch.recent || []).length && (ch.shorts || []).length >= 10;
    if (shortsOnly && !selfInDesc) add(6, '쇼츠만 올림');
    else if (!ch.links && !selfInDesc) add(2, '운영자 정보 없음');

    const ageDays = ch.joinedAt ? (now - ch.joinedAt) / 864e5 : null;
    // 방송사처럼 오래된 대형 채널은 업로드가 많아도 속도 점수를 주지 않음
    const established = ch.subs >= 300000 && ageDays != null && ageDays >= 1825;
    const recent = (ch.recent || []).filter((v) => v.ageDays != null);
    if (!established && recent.length >= 5) {
      const span = Math.max(1, ...recent.map((v) => v.ageDays));
      const rate = recent.length / span;
      const lens = recent.map((v) => v.lenMin).filter((x) => x != null);
      const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
      if (rate >= 3 && avgLen >= 30) add(6, '초인적 장편 다작');
      else if (rate >= 1.5 && avgLen >= 20) add(4, '장편 다작');
    }

    // 가입 후 하루 0.3개 넘게 쌓는 채널. 운영자 정보 없음과 겹쳐야 대상
    const lifeRate = ageDays ? (ch.videos || 0) / Math.max(ageDays, 1) : 0;
    if (!established && ageDays != null && ch.videos >= 30) {
      if (lifeRate >= 3) add(6, '초다작');
      else if (lifeRate >= 0.3) add(4, '다작');
    }
    if (RX.autoHandle.test(ch.handle || '')) add(1, '자동 핸들');

    return { score, why, target: score >= 6, skip: false };
  }

  const api = { classify, RX, SMALL_SUBS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__ytSweep = Object.assign(root.__ytSweep || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
