// 유튜브 innertube 응답과 카드 데이터에서 필요한 값만 꺼냄. 브라우저와 node 공용
(function (root) {
  function find(o, pred, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 40) return null;
    if (pred(o)) return o;
    for (const v of Object.values(o)) {
      const hit = find(v, pred, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function findAll(o, pred, out = [], depth = 0) {
    if (!o || typeof o !== 'object' || depth > 40) return out;
    if (pred(o)) { out.push(o); return out; }
    for (const v of Object.values(o)) findAll(v, pred, out, depth + 1);
    return out;
  }

  const textOf = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.content) return t.content;
    if (t.simpleText) return t.simpleText;
    if (t.runs) return t.runs.map((r) => r.text).join('');
    return '';
  };

  function strings(o) {
    const out = [];
    findAll(o, (x) => {
      for (const k of ['content', 'text', 'simpleText']) if (typeof x[k] === 'string') out.push(x[k]);
      return false;
    });
    return out;
  }

  // 3시간 전, 2일 전 같은 상대 시각을 일 단위로
  function relDays(text) {
    const m = String(text || '').match(/(\d+)\s*(초|분|시간|일|주|개월|년)\s*전/);
    if (!m) return null;
    return +m[1] * { 초: 1 / 86400, 분: 1 / 1440, 시간: 1 / 24, 일: 1, 주: 7, 개월: 30, 년: 365 }[m[2]];
  }

  function parseCount(text) {
    const m = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*(천|만|억)?/);
    return m ? +m[1] * ({ 천: 1e3, 만: 1e4, 억: 1e8 }[m[2]] || 1) : 0;
  }

  function parseJoined(text) {
    const m = String(text || '').match(/(\d{4})\.\s*(\d+)\.\s*(\d+)/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
  }

  const lengthMin = (t) => (/^\d+(:\d+){1,2}$/.test(t || '') ? t.split(':').reduce((m, p) => m * 60 + +p, 0) / 60 : null);

  // 메뉴 항목의 피드백 토큰. 새 UI listItemViewModel과 옛 UI menuServiceItemRenderer 모두 지원
  function menuToken(o, label) {
    const item = find(o, (x) =>
      (x.listItemViewModel && textOf(x.listItemViewModel.title) === label) ||
      (x.menuServiceItemRenderer && textOf(x.menuServiceItemRenderer.text) === label));
    if (!item) return null;
    const fb = find(item, (x) => x.feedbackEndpoint && x.feedbackEndpoint.feedbackToken);
    if (!fb) return null;
    const undo = find(item, (x) => x.undoFeedbackEndpoint && x.undoFeedbackEndpoint.undoToken);
    return { token: fb.feedbackEndpoint.feedbackToken, undo: undo ? undo.undoFeedbackEndpoint.undoToken : null };
  }

  const NOT_INTERESTED = '관심 없음';
  const DONT_RECOMMEND = '채널 추천 안함';

  // 피드 카드 하나. lockupViewModel, videoRenderer, shortsLockupViewModel 형식을 같은 모양으로
  function cardInfo(data) {
    if (!data || typeof data !== 'object') return null;
    if (find(data, (x) => x.adSlotRenderer || x.promotedSparklesWebRenderer || x.inFeedAdLayoutRenderer)) return null;
    const lockup = data.lockupViewModel || (data.contentId && data.rendererContext ? data : null) || (find(data, (x) => x.lockupViewModel) || {}).lockupViewModel;
    const video = data.videoRenderer || (data.videoId && data.ownerText ? data : null) || (find(data, (x) => x.videoRenderer) || {}).videoRenderer;
    const shorts = data.shortsLockupViewModel || (data.entityId && /^shorts/.test(data.entityId) ? data : null) || (find(data, (x) => x.shortsLockupViewModel) || {}).shortsLockupViewModel;

    let videoId = null, title = '', isShort = false, src = null;
    if (lockup && /VIDEO/.test(lockup.contentType || 'VIDEO')) {
      src = lockup; videoId = lockup.contentId;
      title = textOf(((lockup.metadata || {}).lockupMetadataViewModel || {}).title);
    } else if (video) {
      src = video; videoId = video.videoId; title = textOf(video.title);
    } else if (shorts) {
      src = shorts; isShort = true;
      const ep = find(shorts, (x) => x.reelWatchEndpoint);
      videoId = ep && ep.reelWatchEndpoint.videoId;
      title = textOf(((shorts.overlayMetadata || {}).primaryText));
    }
    if (!src || !videoId) return null;

    const browse = find(src, (x) => x.browseEndpoint && /^UC/.test(x.browseEndpoint.browseId || ''));
    const nameNode = find(src, (x) => typeof x.content === 'string' && Array.isArray(x.commandRuns)) ||
      ((video && video.ownerText) ? { content: textOf(video.ownerText) } : null);
    return {
      videoId,
      title,
      isShort,
      channelId: browse ? browse.browseEndpoint.browseId : null,
      channelName: nameNode ? nameNode.content : '',
      notInterested: menuToken(src, NOT_INTERESTED),
      dontRecommend: menuToken(src, DONT_RECOMMEND),
    };
  }

  // reel_item_watch 응답에서 쇼츠의 채널, 메뉴 토큰, 그 쇼츠의 AI 표시
  function reelInfo(res) {
    const overlay = res && res.overlay;
    if (!overlay) return null;
    const browse = find(overlay, (x) => x.browseEndpoint && /^UC/.test(x.browseEndpoint.browseId || ''));
    return {
      channelId: browse ? browse.browseEndpoint.browseId : null,
      notInterested: menuToken(res, NOT_INTERESTED),
      dontRecommend: menuToken(res, DONT_RECOMMEND),
      aiLabeled: aiLabeled(res),
    };
  }

  // 채널 동영상 탭 browse 응답
  function channelPage(res) {
    const recent = findAll(res && res.contents, (x) => x.lockupViewModel).map(({ lockupViewModel: v }) => {
      const s = strings(v.metadata);
      return {
        videoId: v.contentId,
        title: s[0] || '',
        ageDays: relDays(s.find((t) => /전$/.test(t)) || ''),
        lenMin: lengthMin(strings(v.contentImage).find((t) => /^\d+(:\d+){1,2}$/.test(t))),
      };
    });
    const cont = find(res && res.header, (x) => x.continuationCommand && x.continuationCommand.token && JSON.stringify(x).length < 3000);
    const fw = JSON.stringify((res && res.frameworkUpdates) || {});
    return {
      recent,
      aboutToken: cont ? cont.continuationCommand.token : null,
      subscribed: /"subscribed":true/.test(fw),
    };
  }

  // 채널 소개 패널 continuation 응답
  function channelAbout(res) {
    const a = (find(res, (x) => x.aboutChannelViewModel) || {}).aboutChannelViewModel;
    if (!a) return null;
    return {
      joinedAt: parseJoined(textOf(a.joinedDateText)),
      desc: a.description || '',
      links: (a.links || []).length,
      handle: decodeURIComponent(String(a.canonicalChannelUrl || '').split('@')[1] || ''),
      subs: a.subscriberCountText ? parseCount(a.subscriberCountText) : null,
      videos: parseCount(a.videoCountText),
    };
  }

  // 쇼츠 탭 browse 응답의 영상 ID와 제목
  function shortsPage(res) {
    return findAll(res && res.contents, (x) => x.shortsLockupViewModel).map(({ shortsLockupViewModel: v }) => {
      const ep = find(v, (x) => x.reelWatchEndpoint);
      return { videoId: ep ? ep.reelWatchEndpoint.videoId : null, title: textOf((v.overlayMetadata || {}).primaryText) };
    }).filter((v) => v.videoId);
  }

  // next 응답의 영상 설명
  function videoDesc(res) {
    const d = find(res, (x) => x.attributedDescription && typeof x.attributedDescription.content === 'string');
    return d ? d.attributedDescription.content : '';
  }

  // next 응답의 콘텐츠 생성 방식 패널, AI 제작이나 변경 영상 표시
  function aiLabeled(res) {
    const h = find(res, (x) => x.howThisWasMadeSectionViewModel);
    return !!h && strings(h).some((t) => /변경되었거나|새롭게 생성|AI로 제작/.test(t));
  }

  const api = { find, findAll, textOf, strings, relDays, parseCount, parseJoined, menuToken, cardInfo, reelInfo, channelPage, channelAbout, shortsPage, videoDesc, aiLabeled };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__ytSweep = Object.assign(root.__ytSweep || {}, { parse: api });
})(typeof window !== 'undefined' ? window : globalThis);
