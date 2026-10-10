// 채널 수치로 AI 양산 채널 점수 계산. 외부 요청 없는 순수 함수라 브라우저와 node 공용
(function (root) {
  const RX = {
    // AI 학습 금지 같은 저작권 문구와 각색, 창작은 사람 채널에도 흔해 제외
    disclosure: /AI\s*(기술|도구|툴|음성|목소리|나레이션|내레이션|더빙|성우)?\s*(을|를|로|으로)?\s*(활용|이용|사용|제작|생성)|AI로\s*(제작|생성|만든)|(AI|인공지능)\s*(음성|목소리|나레이션|내레이션|더빙)|음성\s*생성|TTS|인공지능(을|으로)\s*(활용|이용|사용)|생성형\s*AI/i,
    notDisclosure: /AI\s*학습/i,
    autoHandle: /-[a-z0-9]{3}$/,
  };

  // channel: { subscribed, subs, videos, joinedAt, desc, links, handle, recent: [{ ageDays, lenMin, title }], aiHit, aiChecked }
  function classify(ch, now) {
    if (ch.subscribed) return { score: 0, why: ['구독 중'], target: false, skip: true };

    let score = 0;
    const why = [];
    const add = (points, reason) => { score += points; why.push(reason); };

    if (ch.aiHit >= 2) add(6, '공식 AI 표시');
    else if (ch.aiHit === 1) add(3, 'AI 표시 일부');

    const desc = ch.desc || '';
    const m = desc.match(RX.disclosure);
    if (m && !RX.notDisclosure.test(m[0])) add(6, 'AI 고지');

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
      else if (rate >= 5) add(2, '초다작');
    }

    if (ageDays != null && ageDays < 180 && ch.videos >= 30) add(2, '신생 다작');
    if (RX.autoHandle.test(ch.handle || '')) add(1, '자동 핸들');
    if (!ch.links) add(1, '링크 없음');
    const titles = (ch.recent || []).map((v) => v.title || '');
    const tags = titles.length ? titles.reduce((n, t) => n + (t.match(/#/g) || []).length, 0) / titles.length : 0;
    if (tags >= 4) add(1, '해시태그 도배');

    return { score, why, target: score >= 6, skip: false };
  }

  const api = { classify, RX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__ytSweep = Object.assign(root.__ytSweep || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
