// 유튜브 페이지 MAIN world에서 실행. 카드 데이터는 Polymer data와 rawProps에서 읽음
(() => {
  'use strict';
  if (window.__ytSweepLoaded) return;
  window.__ytSweepLoaded = true;

  const { classify, parse: P } = window.__ytSweep;
  const KEY = 'yt-sweep-v1';
  const DEFAULTS = {
    mode: 'dry',          // dry 표시만, hide 숨김, act 숨김과 추천 안함 전송
    allow: [],            // 채널 ID 허용 목록
    sent: [],             // 추천 안함을 보낸 채널 기록
    log: [],              // 피드에서 대상으로 판정한 채널 기록. 새로고침해도 패널에 남김
    cache: {},            // 채널 ID별 판정
    day: '', dayCount: 0,
    dailyCap: 200,
  };
  const CACHE_MS = 14 * 864e5;
  const RULES = 3;           // 판정 규칙이 바뀌면 이 값을 올려 캐시를 버림
  const CACHE_MAX = 3000;
  const SENT_MAX = 500;
  const LOG_MAX = 500;
  const LOOKUP_GAP_MS = 300;
  const SEND_GAP_MS = 5000;
  const VIDEOS_TAB = 'EgZ2aWRlb3PyBgQKAjoA';
  const SHORTS_TAB = 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D';
  const CARD_SELECTOR = 'ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2';

  const loadConfig = () => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch { return { ...DEFAULTS }; }
  };
  const cfg = loadConfig();
  const save = () => {
    const ids = Object.keys(cfg.cache);
    if (ids.length > CACHE_MAX) {
      ids.sort((a, b) => cfg.cache[a].at - cfg.cache[b].at).slice(0, ids.length - CACHE_MAX).forEach((id) => delete cfg.cache[id]);
    }
    localStorage.setItem(KEY, JSON.stringify(cfg));
  };
  window.addEventListener('storage', (event) => { if (event.key === KEY) Object.assign(cfg, loadConfig()); });

  // innertube 요청. 로그인 요청은 SAPISIDHASH 인증이 있어야 응답에 추천 안함 메뉴가 포함됨
  const yc = () => (window.ytcfg && window.ytcfg.data_) || {};
  async function authHeader() {
    const sapisid = (document.cookie.match(/(?:^|; )(?:SAPISID|__Secure-3PAPISID)=([^;]+)/) || [])[1];
    if (!sapisid) return null;
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sapisid} ${location.origin}`));
    return `SAPISIDHASH ${ts}_${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  async function api(path, body) {
    const c = yc();
    const headers = {
      'content-type': 'application/json',
      'x-origin': location.origin,
      'x-goog-authuser': String(c.SESSION_INDEX ?? 0),
      'x-youtube-client-name': '1',
      'x-youtube-client-version': c.INNERTUBE_CLIENT_VERSION,
    };
    const auth = await authHeader();
    if (auth) headers.authorization = auth;
    const res = await fetch(`/youtubei/v1/${path}?prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context: c.INNERTUBE_CONTEXT, ...body }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 카드와 영상 정보
  const videos = new Map();     // videoId별 { channelId, channelName, title, isShort, notInterested, dontRecommend }
  const channels = new Map();   // channelId별 { name, videoIds:Set }
  const pendingVideo = new Set();
  const pendingChannel = new Set();
  const lookupQueue = [];       // { kind: 'video'|'channel', id }
  let lastError = '';

  function elementData(el) {
    const raw = el.rawProps && el.rawProps.data;
    if (raw) return typeof raw === 'function' ? raw() : raw;
    return el.data || (el.__data && el.__data.data) || null;
  }

  function remember(info) {
    const prev = videos.get(info.videoId) || {};
    const merged = { ...prev };
    for (const [k, v] of Object.entries(info)) if (v != null && v !== '') merged[k] = v;
    videos.set(info.videoId, merged);
    if (merged.channelId) {
      const ch = channels.get(merged.channelId) || { name: '', videoIds: new Set() };
      if (merged.channelName) ch.name = merged.channelName;
      ch.videoIds.add(info.videoId);
      channels.set(merged.channelId, ch);
    }
    return merged;
  }

  function scan() {
    for (const el of document.querySelectorAll(CARD_SELECTOR)) {
      // 홈 카드는 rich-item 쪽에서 한 번만 처리
      if (el.tagName !== 'YTD-RICH-ITEM-RENDERER' && el.closest('ytd-rich-item-renderer')) continue;
      let info;
      try { info = P.cardInfo(elementData(el)); } catch { info = null; }
      if (!info) continue;
      if (el.dataset.ysVid !== info.videoId) { el.dataset.ysVid = info.videoId; clearMark(el); }
      const v = remember(info);
      if (!v.channelId) { want('video', info.videoId); continue; }
      want('channel', v.channelId);
      apply(el, v);
    }
    checkShortsPlayer();
  }

  function want(kind, id) {
    const pending = kind === 'video' ? pendingVideo : pendingChannel;
    if (pending.has(id)) return;
    if (kind === 'channel' && verdictOf(id)) return;
    pending.add(id);
    lookupQueue.push({ kind, id });
  }

  const verdictOf = (channelId) => {
    const c = cfg.cache[channelId];
    return c && c.rules === RULES && Date.now() - c.at < CACHE_MS ? c : null;
  };

  // 채널 판정에 쓰는 요청 4~6번. 채널마다 한 번만 하고 결과를 저장
  async function lookupChannel(id) {
    const page = P.channelPage(await api('browse', { browseId: id, params: VIDEOS_TAB }));
    await sleep(LOOKUP_GAP_MS);
    let ch = { subscribed: page.subscribed };
    if (!page.subscribed) {
      let about = null;
      if (page.aboutToken) {
        about = P.channelAbout(await api('browse', { continuation: page.aboutToken }));
        await sleep(LOOKUP_GAP_MS);
      }
      const shorts = P.shortsPage(await api('browse', { browseId: id, params: SHORTS_TAB }));
      await sleep(LOOKUP_GAP_MS);
      // AI 표시는 앞의 두 영상으로 셈. 롱폼 채널은 쇼츠 하나의 설명도 함께 확인
      const sample = (page.recent.length ? page.recent : shorts).slice(0, 2).map((v) => v.videoId);
      if (page.recent.length && shorts.length) sample.push(shorts[0].videoId);
      let aiHit = 0;
      const videoDescs = [];
      for (const [i, videoId] of sample.entries()) {
        const res = await api('next', { videoId });
        if (i < 2 && P.aiLabeled(res)) aiHit++;
        videoDescs.push(P.videoDesc(res));
        await sleep(LOOKUP_GAP_MS);
      }
      ch = { ...(about || {}), ...ch, recent: page.recent, shorts, videoDescs, aiHit, aiChecked: Math.min(2, sample.length) };
    }
    const result = classify(ch, Date.now());
    if (!result.target && cfg.log.some((e) => e.id === id)) cfg.log = cfg.log.filter((e) => e.id !== id);
    const known = channels.get(id);
    cfg.cache[id] = {
      at: Date.now(), rules: RULES, score: result.score, why: result.why, target: result.target,
      name: (known && known.name) || ch.handle || id, handle: ch.handle || '',
    };
    save();
  }

  async function lookupVideo(videoId) {
    const info = P.reelInfo(await api('reel/reel_item_watch', { playerRequest: { videoId }, disablePlayerResponse: true }));
    if (info && info.channelId) {
      remember({ videoId, ...info });
      want('channel', info.channelId);
    }
  }

  let lookupBusy = false;
  async function lookupLoop() {
    if (lookupBusy) return;
    lookupBusy = true;
    try {
      while (lookupQueue.length) {
        const job = lookupQueue.shift();
        try {
          if (job.kind === 'video') await lookupVideo(job.id);
          else await lookupChannel(job.id);
          lastError = '';
        } catch (e) {
          lastError = `조회 실패: ${e.message}. 1분 뒤 다시 시도합니다.`;
          lookupQueue.unshift(job);
          renderSoon();
          await sleep(60000);
          continue;
        } finally {
          (job.kind === 'video' ? pendingVideo : pendingChannel).delete(job.id);
        }
        await sleep(LOOKUP_GAP_MS);
        scan();
        renderSoon();
      }
    } finally {
      lookupBusy = false;
    }
  }

  // 카드 표시와 숨김
  function clearMark(el) {
    delete el.dataset.ys;
    const old = el.querySelector(':scope > .ys-badge');
    if (old) old.remove();
  }

  // 채널이 대상이 아니어도 유튜브 AI 표시가 있는 쇼츠는 그 영상만 처리
  function videoVerdict(v) {
    if (cfg.allow.includes(v.channelId)) return null;
    const verdict = verdictOf(v.channelId);
    if (verdict && verdict.target) return { ...verdict, channel: true };
    if (v.aiLabeled) return { score: 0, why: ['이 영상에 공식 AI 표시'], channel: false };
    return null;
  }

  function record(channelId, verdict) {
    const entry = cfg.log.find((e) => e.id === channelId);
    if (entry && entry.score === verdict.score) return;
    if (entry) Object.assign(entry, { name: verdict.name || entry.name, score: verdict.score, why: verdict.why });
    else {
      cfg.log.unshift({ id: channelId, name: verdict.name || '', score: verdict.score, why: verdict.why, at: Date.now() });
      cfg.log.length = Math.min(cfg.log.length, LOG_MAX);
    }
    save();
    renderSoon();
  }

  function badgeFor(v, verdict) {
    const text = verdict.channel ? `${verdict.score}점: ${verdict.why.join(', ')}` : verdict.why.join(', ');
    const send = verdict.channel && v.dontRecommend ? el_('button', { textContent: '추천 안함' }) : null;
    const ok = verdict.channel ? el_('button', { textContent: '허용' }) : null;
    const badge = el_('div', { className: 'ys-badge', title: text }, [el_('span', { textContent: text }), ...[send, ok].filter(Boolean)]);
    // 배지를 눌러도 카드 링크로 이동하지 않게 기본 동작과 전파를 취소
    badge.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (send && event.target === send) { send.textContent = '보내는 중'; send.disabled = true; queueSend(v.channelId); }
      else if (ok && event.target === ok) allow(v.channelId);
    });
    return badge;
  }

  function apply(el, v) {
    const verdict = videoVerdict(v);
    if (!verdict) { clearMark(el); return; }
    if (verdict.channel) record(v.channelId, verdict);
    // 추천 안함을 보낸 채널은 표시만 모드에서도 숨김
    const sent = verdict.channel && sentIds().has(v.channelId);
    if (cfg.mode === 'dry' && !sent) {
      if (el.dataset.ys !== 'mark') {
        clearMark(el);
        el.dataset.ys = 'mark';
        el.prepend(badgeFor(v, verdict));
      }
      return;
    }
    if (el.dataset.ys !== 'hide') { clearMark(el); el.dataset.ys = 'hide'; }
    if (cfg.mode === 'act') {
      if (verdict.channel) queueSend(v.channelId);
      else notInterested(v);
    }
  }

  // 쇼츠 플레이어는 주소의 영상 ID로 판정
  let shortsSkipped = '';
  function checkShortsPlayer() {
    const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
    if (!m) return;
    const videoId = m[1];
    const v = videos.get(videoId);
    if (!v || !v.channelId) { want('video', videoId); return; }
    want('channel', v.channelId);
    const verdict = videoVerdict(v);
    if (verdict && verdict.channel) record(v.channelId, verdict);
    if (!verdict || cfg.mode === 'dry') return;
    if (cfg.mode === 'act') {
      if (verdict.channel) queueSend(v.channelId);
      else notInterested(v);
    }
    if (shortsSkipped !== videoId) {
      shortsSkipped = videoId;
      const next = document.querySelector('#navigation-button-down button, button[aria-label="다음 동영상"]');
      if (next) next.click();
    }
  }

  // 추천 안함 전송
  const sendQueue = [];
  const sentIds = () => new Set(cfg.sent.map((s) => s.id));
  const today = () => new Date().toISOString().slice(0, 10);

  function queueSend(channelId) {
    if (sentIds().has(channelId) || sendQueue.includes(channelId)) return;
    sendQueue.push(channelId);
    sendLoop();
  }

  // 채널의 아무 카드에서나 추천 안함 토큰을 찾음
  function tokensFor(channelId) {
    const ch = channels.get(channelId);
    if (!ch) return null;
    for (const id of ch.videoIds) {
      const v = videos.get(id);
      if (v && v.dontRecommend) return v;
    }
    return null;
  }

  let sendBusy = false;
  async function sendLoop() {
    if (sendBusy) return;
    sendBusy = true;
    try {
      while (sendQueue.length) {
        if (cfg.day !== today()) { cfg.day = today(); cfg.dayCount = 0; }
        if (cfg.dayCount >= cfg.dailyCap) { lastError = `오늘 상한 ${cfg.dailyCap}개를 채워 내일 다시 보냅니다.`; break; }
        const channelId = sendQueue[0];
        const v = tokensFor(channelId);
        if (!v) { sendQueue.shift(); continue; }
        try {
          const res = await api('feedback', { feedbackTokens: [v.dontRecommend.token], isFeedbackTokenUnencrypted: false, shouldMerge: false });
          const ok = !!P.find(res, (x) => x.isProcessed === true);
          if (!ok) throw new Error('처리되지 않음');
          if (v.notInterested) {
            await sleep(1000);
            await api('feedback', { feedbackTokens: [v.notInterested.token], isFeedbackTokenUnencrypted: false, shouldMerge: false }).catch(() => {});
          }
          const verdict = cfg.cache[channelId] || {};
          cfg.sent.unshift({ id: channelId, name: verdict.name || '', why: verdict.why || [], score: verdict.score || 0, undo: v.dontRecommend.undo, at: Date.now() });
          cfg.sent.length = Math.min(cfg.sent.length, SENT_MAX);
          cfg.dayCount++;
          save();
          lastError = '';
          scan();
        } catch (e) {
          lastError = `추천 안함 실패: ${e.message}. 5분 뒤 다시 시도합니다.`;
          renderSoon();
          await sleep(300000);
          continue;
        }
        sendQueue.shift();
        renderSoon();
        await sleep(SEND_GAP_MS);
      }
    } finally {
      sendBusy = false;
    }
  }

  // 채널은 두고 그 영상에만 관심 없음
  const notInterestedSent = new Set();
  async function notInterested(v) {
    if (!v.notInterested || notInterestedSent.has(v.videoId)) return;
    notInterestedSent.add(v.videoId);
    try {
      await api('feedback', { feedbackTokens: [v.notInterested.token], isFeedbackTokenUnencrypted: false, shouldMerge: false });
      cfg.notInterestedCount = (cfg.notInterestedCount || 0) + 1;
      save();
      renderSoon();
    } catch (e) {
      notInterestedSent.delete(v.videoId);
      lastError = `관심 없음 실패: ${e.message}`;
    }
  }

  async function undoSend(entry) {
    if (!entry.undo) { lastError = '되돌리기 토큰이 없습니다. 유튜브 기록에서 직접 지워주세요.'; renderSoon(); return; }
    try {
      const res = await api('feedback', { feedbackTokens: [entry.undo], isFeedbackTokenUnencrypted: false, shouldMerge: false });
      if (!P.find(res, (x) => x.isProcessed === true)) throw new Error('유튜브가 처리하지 않았습니다');
      cfg.sent = cfg.sent.filter((s) => s !== entry);
      allow(entry.id);
    } catch (e) {
      lastError = `되돌리기 실패: ${e.message}`;
      renderSoon();
    }
  }

  function allow(channelId) {
    if (!cfg.allow.includes(channelId)) cfg.allow.push(channelId);
    save();
    for (const el of document.querySelectorAll('[data-ys]')) clearMark(el);
    scan();
    renderSoon();
  }

  function unallow(channelId) {
    cfg.allow = cfg.allow.filter((id) => id !== channelId);
    save();
    scan();
    renderSoon();
  }

  // 패널
  let panelOpen = false;
  let root = null;
  let renderTimer = null;
  const renderSoon = () => { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 300); };

  const CSS = `
    [data-ys="hide"] { display: none !important; }
    [data-ys="mark"] { position: relative; outline: 2px solid #f5a623; outline-offset: -2px; border-radius: 12px; }
    .ys-badge { position: absolute; top: 6px; left: 6px; right: 6px; z-index: 5; display: flex; gap: 4px; align-items: center; padding: 3px 4px 3px 8px; border-radius: 6px;
      background: rgba(0, 0, 0, 0.85); color: #f5a623; font: 12px/1.4 system-ui, sans-serif; cursor: default; }
    .ys-badge span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ys-badge button { flex: none; font: inherit; color: #3ea6ff; background: none; border: 0; padding: 0 4px; cursor: pointer; }
    .ys-badge button:hover { text-decoration: underline; }
    .ys-badge button:disabled { color: #aaa; cursor: default; text-decoration: none; }
    #ys-root[hidden] { display: none !important; }
    #ys-root { position: fixed; left: 12px; bottom: 12px; z-index: 9999; font: 13px/1.4 system-ui, sans-serif; color: #f1f1f1; }
    #ys-root button { font: inherit; color: inherit; background: #272727; border: 1px solid #3f3f3f; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    #ys-root button.on { background: #3ea6ff; border-color: #3ea6ff; color: #0f0f0f; }
    #ys-pill { border-radius: 999px !important; padding: 6px 12px !important; background: #0f0f0f !important; }
    #ys-panel { width: 360px; max-height: 60vh; overflow: auto; margin-bottom: 8px; padding: 12px; background: #0f0f0f; border: 1px solid #3f3f3f; border-radius: 12px; }
    #ys-panel h4 { margin: 10px 0 4px; font-size: 12px; color: #aaa; font-weight: 600; }
    #ys-panel .row { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
    #ys-panel .title { justify-content: space-between; font-weight: 600; }
    #ys-panel .msg { display: block; }
    #ys-panel .item { display: flex; gap: 6px; align-items: baseline; padding: 3px 0; border-top: 1px solid #272727; }
    #ys-panel .item span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #ys-panel a { color: #f1f1f1; font-weight: 600; text-decoration: none; }
    #ys-panel a:hover { text-decoration: underline; }
    #ys-panel .err { color: #ff4e45; }`;

  const el_ = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) node.append(child);
    return node;
  };
  const lines = (text) => text.split(/(?<=[.?!])\s+/).flatMap((line, i) => (i ? [el_('br'), line] : [line]));

  function render() {
    if (!document.body) return;
    if (!root) {
      document.head.append(el_('style', { textContent: CSS }));
      root = el_('div', { id: 'ys-root' });
      document.body.append(root);
      // 동영상 전체화면 위에 버튼이 남지 않게 숨김
      const syncFullscreen = () => { root.hidden = !!document.fullscreenElement; };
      document.addEventListener('fullscreenchange', syncFullscreen);
      syncFullscreen();
    }
    const oldPanel = root.querySelector('#ys-panel');
    const scrollTop = oldPanel ? oldPanel.scrollTop : 0;

    const seen = [...channels.keys()].map((id) => ({ id, v: verdictOf(id) })).filter((x) => x.v);
    const targets = cfg.log.filter((e) => !cfg.allow.includes(e.id));
    const modeName = { dry: '표시만', hide: '숨김', act: '추천 안함' }[cfg.mode];
    const counts = [`걸린 채널 ${targets.length}`];
    if (cfg.sent.length) counts.push(`추천 안함 ${cfg.sent.length}`);
    if (cfg.notInterestedCount) counts.push(`관심 없음 ${cfg.notInterestedCount}`);
    if (lookupQueue.length) counts.push(`확인 중 ${lookupQueue.length}`);
    const pill = el_('button', { id: 'ys-pill', textContent: `${modeName}: ${counts.join(', ')}` });
    pill.addEventListener('click', () => { panelOpen = !panelOpen; render(); });

    const children = [];
    if (panelOpen) {
      const button = (text, onClick, on) => { const b = el_('button', { textContent: text, className: on ? 'on' : '' }); b.addEventListener('click', onClick); return b; };
      const link = (id, name) => el_('a', { href: '/channel/' + id, textContent: name || id, target: '_blank' });
      const item = (id, name, text, buttons) => el_('div', { className: 'item', title: text }, [link(id, name), el_('span', { textContent: text }), ...buttons]);
      const modes = [['dry', '표시만'], ['hide', '숨김'], ['act', '숨김과 추천 안함']].map(([mode, label]) =>
        button(label, () => { cfg.mode = mode; save(); for (const el of document.querySelectorAll('[data-ys]')) clearMark(el); scan(); render(); }, cfg.mode === mode));
      const sent = sentIds();
      // 추천 안함 토큰은 이번 페이지에서 읽은 카드에만 있음
      const list = targets.slice(0, 100).map((e) => {
        const state = sent.has(e.id) ? ', 추천 안함 보냄' : sendQueue.includes(e.id) ? ', 보내는 중' : '';
        const canSend = !sent.has(e.id) && !sendQueue.includes(e.id) && tokensFor(e.id);
        return item(e.id, e.name, ` ${e.score}점: ${e.why.join(', ')}${state}`, [
          ...(canSend ? [button('추천 안함', () => { queueSend(e.id); render(); })] : []),
          button('허용', () => allow(e.id)),
        ]);
      });
      const near = seen.filter((x) => !x.v.target && !x.v.why.includes('구독 중') && x.v.score >= 4).slice(0, 30).map(({ id, v }) => item(id, v.name, ` ${v.score}점: ${v.why.join(', ')}`, []));
      const recent = cfg.sent.slice(0, 30).map((s) => item(s.id, s.name, ` ${s.score}점`, [button('되돌리기', () => undoSend(s))]));
      const allowed = cfg.allow.map((id) => item(id, (cfg.cache[id] || {}).name, '', [button('취소', () => unallow(id))]));
      children.push(el_('div', { id: 'ys-panel' }, [
        el_('div', { className: 'row title' }, ['YT Sweep', button('닫기', () => { panelOpen = false; render(); })]),
        el_('div', { className: 'row' }, modes),
        ...(lastError ? [el_('div', { className: 'row msg err' }, lines(lastError))] : []),
        el_('h4', { textContent: list.length ? `걸린 채널 ${targets.length}개` : '아직 걸린 채널이 없습니다' }),
        ...list,
        ...(near.length ? [el_('h4', { textContent: `기준에 조금 못 미친 채널 ${near.length}개` }), ...near] : []),
        ...(recent.length ? [el_('h4', { textContent: `추천 안함 보낸 채널 ${cfg.sent.length}개, 오늘 ${cfg.day === today() ? cfg.dayCount : 0}개` }), ...recent] : []),
        ...(allowed.length ? [el_('h4', { textContent: `허용 목록 ${allowed.length}개` }), ...allowed] : []),
      ]));
    }
    root.replaceChildren(...children, pill);
    const panel = root.querySelector('#ys-panel');
    if (panel) panel.scrollTop = scrollTop;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panelOpen) { panelOpen = false; render(); }
  });

  let scanTimer = null;
  const scanSoon = () => { if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); lookupLoop(); }, 300); };

  function start() {
    new MutationObserver(scanSoon).observe(document.body, { childList: true, subtree: true });
    setInterval(() => { scan(); lookupLoop(); }, 2000);
    scan();
    lookupLoop();
    render();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
