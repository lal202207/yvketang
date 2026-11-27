// ==UserScript==
// @name         雨课堂刷课助手（本地审查版）
// @namespace    http://tampermonkey.net/
// @version      3.0.7-local.8
// @description  辅助正常播放与浏览，按本地课堂配置核对网页进度
// @author       风之子
// @license      GPL3
// @match        https://www.yuketang.cn/v2/web/*
// @match        https://www.yuketang.cn/pro/lms/*
// @match        https://www.yuketang.cn/ai-workspace/lms-graph/*
// @match        https://*.officeapps.live.com/p/PowerPointFrame.aspx*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @connect      qn1-next.xuetangonline.com
// @resource     pdfjs https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.mjs#sha256=cbabeebf4df66f3fe736f2fa2792d332e019a878b0aa88d5e2be17d439079de4
// @resource     pdfworker https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.worker.mjs#sha256=43710009ea26bfbcb615524946e46e3aaf8ad927514f5e465e8ff6d18044ffe9
// ==/UserScript==

// 基于 Niuwh/yuketang-jiaoben 3.0.6；保留原作者及 GPL3 许可。
// 2026-11-06：本地渐进改造，替换任务调度；保留原面板交互。
// 2026-11-27：课堂和 Office 课件标识改为本地安装配置。
(() => {
  'use strict';

  // 只在本地安装副本中填写已核验的课堂信息。
  const VerifiedCourse = {
    classroomId: '',
    resourceCount: 0,
    officeLeafId: '',
    officePath: ''
  };

  const Config = {
    version: '3.0.7-local.8',
    playbackRate: 1,
    pptInterval: 3000,
    pollInterval: 250,
    playerTimeout: 20000,
    startTimeout: 15000,
    stallTimeout: 60000,
    progressTimeout: 30000,
    switchTimeout: 15000,
    logLimit: 150
  };

  const Messages = {
    WAIT_PLAYER: '等待播放器加载', STARTING: '正在请求正常播放',
    PLAYING: '正在播放', WAIT_PROGRESS: '等待页面真实进度确认',
    SWITCHING: '页面已确认完成，正在切换下一节', COURSEWARE: '正在播放课件',
    COMPLETE: '当前任务已由页面状态确认完成', PAUSED: '任务已暂停，点击开始重新核验',
    STOPPED: '任务已停止', DUPLICATE: '已有任务运行，忽略重复启动',
    LOCKED: '另一个标签页正在执行任务', LOCK_UNAVAILABLE: '浏览器任务锁不可用，未启动',
    UNSUPPORTED_ROUTE: '当前地址不属于目标站点的三类学习路由',
    PLAYER_TIMEOUT: '未找到唯一可用播放器；请打开资源并确认页面结构',
    MEDIA_ERROR: '播放器报告加载错误，请在页面中检查',
    PLAY_BLOCKED: '浏览器拒绝自动播放，请手动点击网页播放后重试',
    START_TIMEOUT: '未确认播放时间推进，请检查播放器或人工提示',
    STALLED: '播放长时间未推进，已停止等待人工处理',
    PAUSE_DETECTED: '检测到网页或用户暂停，请处理页面提示后继续',
    MEDIA_REPLACED: '播放器已被移除或替换，需要重新核验',
    RESOURCE_UNVERIFIED: '此资源类型未验证，请手动查看；答题与评论未启用',
    PREPARING: '正在展开课程导航并核对资源类型',
    ROUTE_CHANGED: '当前资源已改变，任务暂停等待重新核验',
    PROGRESS_UNVERIFIED: '真实页面进度未适配；播放结束不等于平台完成',
    PROGRESS_TIMEOUT: '未取得当前资源的明确完成状态，未切换下一节',
    NEXT_UNVERIFIED: '当前资源已确认完成；下一节入口未验证，已停止',
    SWITCH_TIMEOUT: '下一节未确认切换成功，已停止，未重复点击',
    CYCLE: '检测到章节重复，已停止',
    SLIDE_INVALID: '课件页码或翻页控件不明确，已停止',
    SLIDE_TIMEOUT: '课件翻页未确认成功，已停止',
    PDF_ERROR: 'PDF 加载或渲染失败，未将附件计为逐页完成',
    PDF_TIMEOUT: 'PDF 加载或渲染超时，已取消',
    READING_START: '请先打开需要浏览的图文；从第一项图文开始可依次浏览全部课件',
    STORAGE: '本地存储不可用，当前记录仅保留在本页内存',
    SETTINGS: '倍速范围为 0.5–3，课件每页间隔为 1–60 秒',
    RECOVERY_INVALID: '没有同一资源的有效恢复记录，请直接开始',
    UNEXPECTED: '任务出现异常，已停止；请检查页面后重试'
  };
  const States = {
    idle: '空闲', waiting_player: '等待播放器', starting: '准备播放', playing: '播放中',
    courseware: '课件播放中', waiting_progress: '核验页面进度', switching: '切换章节',
    paused: '已暂停', stopped: '已停止', needs_user: '等待人工处理', error: '出错',
    completed: '已确认完成'
  };

  class TaskError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  const fail = code => { throw new TaskError(code); };
  const cancelled = signal => {
    if (signal.aborted) throw signal.reason;
  };
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      cancelled(signal);
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  async function waitFor(check, { timeout = Infinity, interval, signal, code }) {
    const deadline = Date.now() + timeout;
    for (;;) {
      cancelled(signal);
      const value = check();
      if (value) return value;
      if (Date.now() >= deadline) fail(code);
      await delay(Math.min(interval, Math.max(1, deadline - Date.now())), signal);
    }
  }
  function boundedAction(action, timeout, signal, code = 'START_TIMEOUT') {
    return new Promise((resolve, reject) => {
      cancelled(signal);
      const finish = (fn, value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, signal.reason);
      const timer = setTimeout(() => finish(reject, new TaskError(code)), timeout);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => { cancelled(signal); return action(); })
        .then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  let pdfLibraryPromise;
  function getPdfLibrary() {
    if (!pdfLibraryPromise) {
      const moduleUrl = URL.createObjectURL(new Blob([GM_getResourceText('pdfjs')], { type: 'text/javascript' }));
      const workerUrl = URL.createObjectURL(new Blob([GM_getResourceText('pdfworker')], { type: 'text/javascript' }));
      pdfLibraryPromise = import(moduleUrl).then(library => {
        library.GlobalWorkerOptions.workerSrc = workerUrl;
        return library;
      }).catch(error => {
        URL.revokeObjectURL(workerUrl);
        pdfLibraryPromise = null;
        throw error;
      }).finally(() => URL.revokeObjectURL(moduleUrl));
    }
    return pdfLibraryPromise;
  }
  function pdfUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { fail('PDF_ERROR'); }
    if (url.origin !== 'https://qn1-next.xuetangonline.com' || url.username || url.password
      || !url.pathname.endsWith('.pdf')) fail('PDF_ERROR');
    url.hash = '';
    return url.href;
  }
  function downloadPdf(value, signal, timeout, request = GM_xmlhttpRequest) {
    const url = pdfUrl(value);
    return new Promise((resolve, reject) => {
      cancelled(signal);
      let handle;
      const finish = (fn, result) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        fn(result);
      };
      const onAbort = () => { finish(reject, signal.reason); handle?.abort(); };
      // anonymous 在 Chrome 中使用 fetch；由本地计时器取消，不依赖扩展的 timeout。
      const timer = setTimeout(() => { finish(reject, new TaskError('PDF_TIMEOUT')); handle?.abort(); }, timeout);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        handle = request({ method: 'GET', url, anonymous: true, redirect: 'error', responseType: 'arraybuffer',
          onload: response => response.status === 200 && response.response?.byteLength > 0
            ? finish(resolve, response.response) : finish(reject, new TaskError('PDF_ERROR')),
          onerror: () => finish(reject, new TaskError('PDF_ERROR')) });
      } catch (_) { finish(reject, new TaskError('PDF_ERROR')); }
    });
  }
  async function browsePdf(iframe, { signal, config, guard, onPage = () => {},
    loadLibrary = getPdfLibrary, download = downloadPdf }) {
    const source = pdfUrl(iframe.getAttribute('src'));
    const doc = iframe.ownerDocument;
    let loadingTask, renderTask;
    const check = () => {
      guard();
      if (!iframe.isConnected || pdfUrl(iframe.getAttribute('src')) !== source) fail('MEDIA_REPLACED');
    };
    const action = fn => boundedAction(fn, config.playerTimeout, signal, 'PDF_TIMEOUT');
    try {
      check();
      const library = await action(loadLibrary);
      const data = await download(source, signal, config.playerTimeout);
      check();
      loadingTask = library.getDocument({ data: new Uint8Array(data), isEvalSupported: false, stopAtErrors: true });
      const pdf = await action(() => loadingTask.promise);
      if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) fail('PDF_ERROR');
      iframe.parentElement.querySelector('.ykt-pdf-viewer')?.remove();
      const viewer = doc.createElement('div');
      viewer.className = 'ykt-pdf-viewer';
      viewer.setAttribute('role', 'region');
      viewer.setAttribute('aria-label', 'PDF 课件');
      iframe.before(viewer);
      const label = doc.createElement('p');
      label.setAttribute('role', 'status');
      for (let index = 1; index <= pdf.numPages; index++) {
        check();
        const page = await action(() => pdf.getPage(index));
        const original = page.getViewport({ scale: 1 });
        const scale = Math.min((iframe.clientWidth || viewer.parentElement.clientWidth || 800) / original.width,
          (doc.defaultView.innerHeight || 800) * 0.7 / original.height);
        const viewport = page.getViewport({ scale });
        const canvas = doc.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.maxWidth = '100%';
        renderTask = page.render({ canvas, viewport });
        await action(() => renderTask.promise);
        renderTask = null;
        check();
        // 渲染成功后才替换画面和页码；失败、取消不会被记录为已翻页。
        label.textContent = `PDF 第 ${index} / ${pdf.numPages} 页已渲染`;
        viewer.replaceChildren(label, canvas);
        iframe.hidden = true;
        viewer.scrollIntoView?.({ block: 'nearest' });
        onPage({ index, total: pdf.numPages });
        await delay(config.pptInterval, signal);
        check();
        page.cleanup();
      }
    } catch (error) {
      if (signal.aborted || error instanceof TaskError) throw error;
      fail('PDF_ERROR');
    } finally {
      renderTask?.cancel();
      await loadingTask?.destroy();
    }
  }

  const OfficeChannel = 'ykt-office-ppt-v1';
  let officePeer = null;
  function officePptSource(value, course = VerifiedCourse) {
    if (!course?.officePath) return false;
    try {
      const outer = new URL(value);
      const file = new URL(outer.searchParams.get('src'));
      return outer.origin === 'https://view.officeapps.live.com' && outer.pathname === '/op/embed.aspx'
        && file.origin === 'https://qn1-next.xuetangonline.com'
        && file.pathname === course.officePath && file.pathname.endsWith('.ppt')
        && !file.username && !file.password;
    } catch (_) { return false; }
  }
  function officeFrameContext(href, referrer) {
    try {
      const url = new URL(href);
      return url.protocol === 'https:' && /^[a-z0-9-]+-powerpoint\.officeapps\.live\.com$/.test(url.hostname)
        && url.pathname === '/p/PowerPointFrame.aspx'
        && new URL(referrer).origin === 'https://view.officeapps.live.com';
    } catch (_) { return false; }
  }
  function officeSlide(doc) {
    const text = doc.getElementById('SlideLabel-Medium14')?.textContent.replace(/\s/g, '');
    const match = text?.match(/^第(\d+)张幻灯片，共(\d+)张$/);
    const canvas = doc.getElementById('scc');
    if (!match || !canvas || !isVisible(canvas)) fail('SLIDE_INVALID');
    const state = { index: Number(match[1]), total: Number(match[2]),
      hasMedia: [...doc.querySelectorAll('video,audio')].some(isVisible) };
    if (!Number.isInteger(state.index) || state.index < 1 || state.index > state.total) fail('SLIDE_INVALID');
    return state;
  }
  function pressOfficeButton(button) {
    const view = button.ownerDocument.defaultView;
    const { left, top, width, height } = button.getBoundingClientRect();
    const mouse = { view, bubbles: true, cancelable: true, button: 0,
      clientX: left + width / 2, clientY: top + height / 2 };
    // Office 在控件范围内按下并松开才激活该按钮；单独 click 不会翻页。
    button.dispatchEvent(new view.MouseEvent('mousedown', { ...mouse, buttons: 1 }));
    button.dispatchEvent(new view.MouseEvent('mouseup', { ...mouse, buttons: 0 }));
  }
  function bootOfficeChild(win, doc) {
    const token = win.crypto.randomUUID();
    let attempts = 0;
    const hello = () => {
      win.top.postMessage({ channel: OfficeChannel, token, command: 'HELLO' }, 'https://www.yuketang.cn');
      if (++attempts >= 20) clearInterval(timer);
    };
    const timer = setInterval(hello, 1000);
    win.addEventListener('message', event => {
      const message = event.data;
      if (event.origin !== 'https://www.yuketang.cn' || event.source !== win.top
        || message?.channel !== OfficeChannel || message.token !== token) return;
      if (message.command === 'ACK') { clearInterval(timer); return; }
      if (!['STATE', 'NEXT', 'PREV'].includes(message.command) || typeof message.id !== 'string') return;
      const reply = { channel: OfficeChannel, token, id: message.id };
      try {
        const state = officeSlide(doc);
        if (message.command !== 'STATE') {
          if (state.index !== message.index || state.hasMedia) fail('SLIDE_INVALID');
          const next = doc.getElementById(message.command === 'NEXT' ? 'ButtonFastFwd-Small14' : 'ButtonFastBack-Small14');
          if (!isVisible(next) || next.getAttribute('aria-disabled') === 'true') fail('SLIDE_INVALID');
          pressOfficeButton(next);
        }
        reply.state = state;
      } catch (_) { reply.error = true; }
      event.source.postMessage(reply, event.origin);
    });
    win.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    hello();
  }
  function installOfficeParent(win, doc, course = VerifiedCourse) {
    win.addEventListener('message', event => {
      if (event.data?.channel !== OfficeChannel || event.data.command !== 'HELLO'
        || typeof event.data.token !== 'string') return;
      const route = getRoute(win.location.href);
      const frames = doc.querySelectorAll('.main-text-attachment iframe');
      const iframe = frames[0];
      if (!matchesVerifiedCourse(route, course) || route.type !== 'graph' || route.leafId !== course.officeLeafId
        || frames.length !== 1 || !officePptSource(iframe.getAttribute('src'), course)) return;
      try {
        if (!officeFrameContext(event.origin + '/p/PowerPointFrame.aspx', 'https://view.officeapps.live.com')
          || event.source.parent !== iframe.contentWindow) return;
      } catch (_) { return; }
      officePeer = { iframe, source: event.source, origin: event.origin, token: event.data.token };
      event.source.postMessage({ channel: OfficeChannel, token: officePeer.token, command: 'ACK' }, event.origin);
    });
  }
  function requestOffice(peer, command, index, signal, timeout, win) {
    return new Promise((resolve, reject) => {
      cancelled(signal);
      const id = win.crypto.randomUUID();
      const finish = (fn, value) => {
        clearTimeout(timer);
        win.removeEventListener('message', receive);
        signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const receive = event => {
        const message = event.data;
        if (event.source !== peer.source || event.origin !== peer.origin || message?.channel !== OfficeChannel
          || message.token !== peer.token || message.id !== id) return;
        if (message.error) finish(reject, new TaskError('SLIDE_INVALID'));
        else finish(resolve, message.state);
      };
      const onAbort = () => finish(reject, signal.reason);
      const timer = setTimeout(() => finish(reject, new TaskError('SLIDE_TIMEOUT')), timeout);
      win.addEventListener('message', receive);
      signal.addEventListener('abort', onAbort, { once: true });
      peer.source.postMessage({ channel: OfficeChannel, token: peer.token, id, command, index }, peer.origin);
    });
  }
  async function browseOfficePpt(iframe, { signal, config, guard, onPage = () => {}, course = VerifiedCourse,
    getPeer = () => officePeer, request = requestOffice }) {
    const check = () => {
      guard();
      if (!iframe.isConnected || !officePptSource(iframe.getAttribute('src'), course)) fail('MEDIA_REPLACED');
    };
    const peer = await waitFor(() => { check(); return getPeer()?.iframe === iframe ? getPeer() : null; }, {
      signal, interval: config.pollInterval, timeout: config.playerTimeout, code: 'SLIDE_TIMEOUT'
    });
    const read = (command = 'STATE', index) => request(peer, command, index, signal, config.switchTimeout, iframe.ownerDocument.defaultView);
    let state = await read();
    const total = state?.total;
    const valid = value => {
      check();
      if (!value || !Number.isInteger(value.index) || !Number.isInteger(total) || total < 1
        || value.total !== total || value.index < 1 || value.index > total) fail('SLIDE_INVALID');
      if (value.hasMedia) fail('RESOURCE_UNVERIFIED');
      return value;
    };
    const move = async direction => {
      const before = state.index;
      const target = before + direction;
      // Office 的第一次按压可能只结束同页过渡。确认仍在原页后，至多补一次。
      for (let attempt = 0; attempt < 2; attempt++) {
        const deadline = Date.now() + config.switchTimeout;
        let next = await read(direction === 1 ? 'NEXT' : 'PREV', before);
        for (;;) {
          valid(next);
          if (next.index === target) { state = next; return; }
          if (next.index !== before) fail('SLIDE_INVALID');
          if (Date.now() >= deadline) break;
          await delay(config.pollInterval, signal);
          next = await read();
        }
      }
      fail('SLIDE_TIMEOUT');
    };
    valid(state);
    while (state.index > 1) await move(-1);
    for (;;) {
      valid(state);
      onPage({ index: state.index, total });
      await delay(config.pptInterval, signal);
      check();
      if (state.index === total) return;
      await move(1);
    }
  }

  function getRoute(href) {
    let url;
    try { url = new URL(href); } catch (_) { return null; }
    if (url.origin !== 'https://www.yuketang.cn') return null;
    const path = url.pathname;
    let family;
    let classroomId = '';
    let type = '';
    let leafId = '';
    if (/^\/v2\/web\//.test(path)) family = 'v2/web';
    else if (/^\/pro\/lms\//.test(path)) family = 'pro/lms';
    else {
      const match = path.match(/^\/ai-workspace\/lms-graph\/([^/]+)(?:\/([^/]+)\/([^/]+))?\/?$/);
      if (!match) return null;
      family = 'ai-workspace';
      [, classroomId, type = '', leafId = ''] = match;
    }
    classroomId ||= url.searchParams.get('classroom_id')
      || path.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1]
      || path.match(/\/(\d+)\/studycontent\/?$/)?.[1] || '';
    // 只保留课堂查询参数；不记录 token、完整查询字符串或 hash。
    return { family, classroomId, type, leafId, key: JSON.stringify([path, classroomId]) };
  }

  function isVisible(node) {
    if (!node?.isConnected || node.hidden || node.closest?.('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = node.ownerDocument.defaultView.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function matchesVerifiedCourse(route, course) {
    return route?.family === 'ai-workspace' && Boolean(course?.classroomId)
      && route.classroomId === course.classroomId
      && Number.isSafeInteger(course.resourceCount) && course.resourceCount > 0;
  }
  function isProgressDone(text) {
    const value = String(text || '').replace(/\s+/g, '').trim();
    if (/^(?:已完成|已读|100(?:\.0+)?%)$/.test(value)) return true;
    const match = value.match(/^([1-9]\d*)\/([1-9]\d*)$/);
    return Boolean(match && Number.isSafeInteger(Number(match[1])) && match[1] === match[2]);
  }
  function mediaCandidates(doc) {
    return [...doc.querySelectorAll('video, audio')].filter(media => media.isConnected
      && (media.tagName.toLowerCase() === 'audio' || isVisible(media)));
  }
  function createAdapter(route, doc, href = () => doc.location.href, course = VerifiedCourse) {
    let nav = doc.querySelector?.('.learning-space-student-knowledge-nav .nav-list');
    if (matchesVerifiedCourse(route, course) && ['video', 'graph'].includes(route.type) && nav) {
      const active = () => {
        const nodes = nav.querySelectorAll('.leaf-item.is-active');
        return nodes.length === 1 ? nodes[0] : null;
      };
      const tag = node => node?.querySelector('.leaf-item-tag')?.innerText?.trim() || '';
      const title = node => node?.querySelector('.leaf-item-title')?.innerText?.trim() || '';
      const icon = node => node?.querySelector('.leaf-item-status > i.icon-yuanquangou');
      const resources = () => [...nav.querySelectorAll('.nav-item-leaf-box .leaf-item')]
        .filter(node => ['视频', '图文'].includes(tag(node)));
      let expectedTitle = null;
      let previousVideo = null;
      let previousSource = '';
      let preparedItems = null;
      const completeList = items => items.length === course.resourceCount
        && new Set(items.map(node => `${tag(node)}:${title(node)}`)).size === course.resourceCount;
      const bindingReady = () => {
        const current = getRoute(href());
        return current?.family === route.family && current.classroomId === route.classroomId
          && active() && ((current.type === 'video' && tag(active()) === '视频')
            || (current.type === 'graph' && tag(active()) === '图文'))
          && (!expectedTitle || title(active()) === expectedTitle);
      };
      const adapter = {
        family: route.family, verified: true, completionKind: 'yuketang-ai-leaf-icon',
        getLessonKey: () => bindingReady() ? getRoute(href()).key : '',
        getKind: () => getRoute(href())?.type === 'graph' ? 'reading' : 'media',
        getMedia: () => bindingReady() && tag(active()) === '视频'
          ? [...doc.querySelectorAll('.content-detail .learning-space-video .video-box video')]
            .filter(node => isVisible(node) && (node !== previousVideo || node.currentSrc !== previousSource)) : [],
        getCompletion() {
          if (!bindingReady() || !isVisible(icon(active()))) return null;
          if (tag(active()) === '图文') {
            const root = doc.querySelector('.content-detail .lms-graph-article');
            if (root?.querySelector('.learning-space-control-unit .unit-title')?.innerText?.trim() !== title(active())) return null;
            return { node: root.querySelector('.learning-space-control-unit .control-right .f12.color-9b'),
              lessonKey: getRoute(href()).key };
          }
          return { node: icon(active()), lessonKey: getRoute(href()).key };
        },
        getReading() {
          if (!bindingReady() || tag(active()) !== '图文') return null;
          const root = doc.querySelector('.content-detail .lms-graph-article');
          if (root?.querySelector('.learning-space-control-unit .unit-title')?.innerText?.trim() !== title(active())) return null;
          const node = root.querySelector('.main-text-attachment');
          if (node?.querySelectorAll('iframe').length > 1) fail('RESOURCE_UNVERIFIED');
          return node && isVisible(node) ? { node, scrollContainer: node.closest('.scroll-container'),
            pdf: node.querySelector('iframe') } : null;
        },
        getSlide: () => null,
        async prepare(signal, config) {
          nav = doc.querySelector('.learning-space-student-knowledge-nav .nav-list');
          if (!nav) fail('RESOURCE_UNVERIFIED');
          for (;;) {
            cancelled(signal);
            const control = nav.querySelector('.nav-item-node-inner > i.expand-icon:not(.is-expanded)');
            if (!control) {
              // 与本地核验的资源数量核对，避免把尚未加载完整的目录当作终点。
              await waitFor(() => {
                if (getRoute(href())?.key !== route.key) fail('ROUTE_CHANGED');
                const items = resources();
                if (!completeList(items)) return false;
                preparedItems = items;
                return true;
              }, { timeout: config.playerTimeout, interval: config.pollInterval, signal, code: 'RESOURCE_UNVERIFIED' });
              return;
            }
            if (!isVisible(control)) fail('RESOURCE_UNVERIFIED');
            control.click();
            await waitFor(() => {
              if (getRoute(href())?.key !== route.key) fail('ROUTE_CHANGED');
              return control.classList.contains('is-expanded');
            }, { timeout: config.switchTimeout, interval: config.pollInterval, signal, code: 'SWITCH_TIMEOUT' });
          }
        },
        getNext({ readingsOnly = false } = {}) {
          const lessonKey = adapter.getLessonKey();
          if (!lessonKey) return null;
          if (!nav.isConnected || preparedItems?.some(node => !node.isConnected)) return null;
          // prepare 已核对目录；普通切节不重复计算完整性和同名集合。
          const items = preparedItems || resources();
          if (!preparedItems && !completeList(items)) return null;
          const candidates = readingsOnly ? items.slice(items.indexOf(active()) + 1).filter(node => tag(node) === '图文') : items;
          const next = candidates.find(node => node !== active() && (readingsOnly || !isVisible(icon(node))));
          if (!next) return completeList(resources()) && (readingsOnly || items.every(node => isVisible(icon(node))))
            ? { verified: true, lessonKey, end: true } : null;
          return {
            verified: true, lessonKey, node: next,
            beforeClick() {
              expectedTitle = title(next);
              previousVideo = doc.querySelector('.content-detail .learning-space-video .video-box video');
              // 仅在本次切换的内存中比较来源，防止接管尚未换源的旧播放器；不保存或输出地址。
              previousSource = previousVideo?.currentSrc || '';
            }
          };
        }
      };
      return adapter;
    }
    // shortcut: 其余页面尚无真实 DOM 证据；不能据此启用进度或章节切换。
    return {
      family: route.family, verified: false,
      getMedia: () => mediaCandidates(doc).filter(media => !route.type || media.tagName.toLowerCase() === route.type),
      getCompletion: () => null,
      getNext: () => null,
      getSlide: () => null
    };
  }

  function validateSettings(value) {
    return value && Number.isFinite(value.playbackRate) && value.playbackRate >= 0.5
      && value.playbackRate <= 3 && Number.isFinite(value.pptInterval)
      && value.pptInterval >= 1000 && value.pptInterval <= 60000;
  }
  function createStore({ read, write, remove, onError = () => {} }) {
    const prefix = 'ykt_playback_v1_';
    const memory = new Map();
    let available = true;
    const unavailable = () => {
      if (available) { available = false; onError(); }
    };
    return {
      get available() { return available; },
      get(key, fallback = null) {
        if (available) {
          try {
            const value = read(prefix + key, fallback);
            memory.set(key, value);
            return value;
          } catch (_) { unavailable(); }
        }
        return memory.has(key) ? memory.get(key) : fallback;
      },
      set(key, value) {
        memory.set(key, value);
        if (available) {
          try { write(prefix + key, value); } catch (_) { unavailable(); }
        }
      },
      remove(key) {
        memory.delete(key);
        if (available) {
          try { remove(prefix + key); } catch (_) { unavailable(); }
        }
      }
    };
  }

  class PlaybackController {
    constructor({ doc, href, locks, store, adapterFactory = createAdapter, config = {}, course = VerifiedCourse,
      onUpdate = () => {}, pdfReader = browsePdf, pptReader = browseOfficePpt }) {
      this.doc = doc;
      this.href = href;
      this.locks = locks;
      this.store = store;
      this.adapterFactory = adapterFactory;
      this.course = course;
      this.config = { ...Config, ...config };
      const settings = store.get('settings');
      if (validateSettings(settings)) Object.assign(this.config, {
        playbackRate: settings.playbackRate, pptInterval: settings.pptInterval
      });
      this.onUpdate = onUpdate;
      this.pdfReader = pdfReader;
      this.pptReader = pptReader;
      this.state = 'idle';
      this.running = false;
      this.ownsLock = false;
      this.media = null;
      this.taskId = null;
      this.abort = null;
      const savedLogs = store.get('logs', []);
      this.logs = Array.isArray(savedLogs) ? savedLogs.filter(item => item && Messages[item.code]
        && Number.isFinite(item.time) && States[item.state]).slice(-this.config.logLimit) : [];
    }
    log(code, level = 'info') {
      const entry = { time: Date.now(), state: this.state, code, level };
      this.logs.push(entry);
      this.logs = this.logs.slice(-this.config.logLimit);
      this.store.set('logs', this.logs);
      this.onUpdate({ state: this.state, code, level });
    }
    transition(state, code, persist = true) {
      this.state = state;
      if (persist) this.saveCheckpoint();
      this.log(code, state === 'error' ? 'error' : state === 'needs_user' ? 'warn' : 'info');
    }
    saveCheckpoint() {
      if (!this.taskId || !this.ownsLock || !this.route?.key) return;
      this.store.set('checkpoint', {
        version: 1, taskId: this.taskId, route: this.route.key, state: this.state, ts: Date.now(),
        readingsOnly: this.readingsOnly
      });
    }
    getRecovery() {
      const saved = this.store.get('checkpoint');
      const route = getRoute(this.href());
      return saved?.version === 1 && typeof saved.taskId === 'string' && saved.taskId.length > 0
        && route && saved.route === route.key
        && ['waiting_player', 'starting', 'playing', 'courseware', 'waiting_progress',
          'switching', 'paused', 'needs_user', 'error'].includes(saved.state) ? saved : null;
    }
    restore() {
      const saved = this.getRecovery();
      if (!saved) { this.log('RECOVERY_INVALID', 'warn'); return Promise.resolve(false); }
      return this.start({ readingsOnly: saved.readingsOnly === true });
    }
    setSettings(settings) {
      if (!validateSettings(settings)) { this.log('SETTINGS', 'warn'); return false; }
      const saved = { playbackRate: settings.playbackRate, pptInterval: settings.pptInterval };
      Object.assign(this.config, saved);
      this.store.set('settings', saved);
      if (this.media && this.running && this.state === 'playing') {
        this.media.playbackRate = settings.playbackRate;
        this.onUpdate({ state: this.state, actualRate: this.media.playbackRate });
      }
      return true;
    }
    pause(code = 'PAUSED') {
      if (!this.running) return;
      this.abort.abort(new TaskError(code));
      this.media?.pause();
      this.transition('paused', code);
    }
    stop() {
      this.abort?.abort(new TaskError('STOPPED'));
      this.media?.pause();
      const saved = this.store.get('checkpoint');
      if (this.taskId && saved?.taskId === this.taskId) this.store.remove('checkpoint');
      this.transition('stopped', 'STOPPED', false);
    }
    guard(signal, lessonKey = this.lessonKey) {
      cancelled(signal);
      if (getRoute(this.href())?.key !== this.route.key || this.getLessonKey() !== lessonKey) fail('ROUTE_CHANGED');
    }
    getLessonKey() {
      return this.adapter.verified && this.adapter.getLessonKey
        ? this.adapter.getLessonKey() : getRoute(this.href())?.key;
    }
    isComplete() {
      if (!this.adapter.verified) return false;
      const evidence = this.adapter.getCompletion();
      const iconDone = this.adapter.completionKind === 'yuketang-ai-leaf-icon'
        && matchesVerifiedCourse(this.route, this.course)
        && evidence?.node?.matches?.('.leaf-item.is-active .leaf-item-status > i.icon-yuanquangou');
      return evidence?.lessonKey === this.lessonKey && evidence.node?.ownerDocument === this.doc
        && isVisible(evidence.node) && (iconDone || isProgressDone(evidence.node.innerText));
    }
    async start({ readingsOnly = false } = {}) {
      if (this.running) { this.log('DUPLICATE', 'warn'); return false; }
      const route = getRoute(this.href());
      if (!route) { this.transition('needs_user', 'UNSUPPORTED_ROUTE', false); return false; }
      if (readingsOnly && (!matchesVerifiedCourse(route, this.course) || route.type !== 'graph')) {
        this.transition('needs_user', 'READING_START', false); return false;
      }
      if (!this.locks?.request) { this.transition('needs_user', 'LOCK_UNAVAILABLE', false); return false; }
      this.running = true;
      this.abort = new AbortController();
      const signal = this.abort.signal;
      let acquired = false;
      try {
        return await this.locks.request('ykt-playback-task-v1', { ifAvailable: true }, async lock => {
          if (!lock) { this.transition('needs_user', 'LOCKED', false); return false; }
          acquired = true;
          cancelled(signal);
          this.route = route;
          this.readingsOnly = readingsOnly;
          this.taskId = globalThis.crypto.randomUUID();
          this.ownsLock = true;
          this.adapter = this.adapterFactory(route, this.doc, this.href, this.course);
          if (this.adapter.family !== route.family) fail('UNSUPPORTED_ROUTE');
          if (route.type && !['video', 'audio'].includes(route.type) && !this.adapter.verified) fail('RESOURCE_UNVERIFIED');
          if (this.adapter.prepare) {
            this.transition('waiting_player', 'PREPARING');
            await this.adapter.prepare(signal, this.config);
          }
          const visited = new Set();
          for (;;) {
            const currentRoute = getRoute(this.href());
            if (!currentRoute || currentRoute.family !== route.family
              || currentRoute.classroomId !== route.classroomId) fail('ROUTE_CHANGED');
            this.route = currentRoute;
            this.lessonKey = this.getLessonKey();
            if (typeof this.lessonKey !== 'string' || !this.lessonKey || visited.has(this.lessonKey)) fail('CYCLE');
            visited.add(this.lessonKey);
            this.guard(signal);
            if (this.adapter.getKind?.() === 'reading') {
              await this.readCurrent(signal);
            } else if (!this.isComplete()) {
              if (this.adapter.verified && this.adapter.getSlide()) await this.playCourseware(signal);
              else await this.playMedia(signal);
            }
            if (!this.isComplete()) {
              this.transition('waiting_progress', 'WAIT_PROGRESS');
              if (!this.adapter.verified) fail('PROGRESS_UNVERIFIED');
              await waitFor(() => { this.guard(signal); return this.isComplete(); }, {
                timeout: this.config.progressTimeout, interval: this.config.pollInterval,
                signal, code: 'PROGRESS_TIMEOUT'
              });
            }
            this.guard(signal);
            const next = this.adapter.verified ? this.adapter.getNext({ readingsOnly }) : null;
            if (!next?.verified || next.lessonKey !== this.lessonKey) fail('NEXT_UNVERIFIED');
            if (next.end === true) {
              this.transition('completed', 'COMPLETE');
              this.store.remove('checkpoint');
              return true;
            }
            if (!isVisible(next.node) || next.node.ownerDocument !== this.doc
              || next.node.disabled || next.node.getAttribute('aria-disabled') === 'true') fail('NEXT_UNVERIFIED');
            this.transition('switching', 'SWITCHING');
            const previous = this.lessonKey;
            this.guard(signal);
            if (!this.isComplete()) fail('PROGRESS_TIMEOUT');
            next.beforeClick?.();
            next.node.click();
            await waitFor(() => {
              cancelled(signal);
              const current = getRoute(this.href());
              if (!current || current.family !== route.family
                || current.classroomId !== route.classroomId) fail('ROUTE_CHANGED');
              return this.getLessonKey() && this.getLessonKey() !== previous;
            }, { timeout: this.config.switchTimeout, interval: this.config.pollInterval, signal, code: 'SWITCH_TIMEOUT' });
          }
        });
      } catch (error) {
        if (signal.aborted) return false;
        const code = error instanceof TaskError && Messages[error.code] ? error.code : 'UNEXPECTED';
        const paused = code === 'PAUSE_DETECTED' || code === 'ROUTE_CHANGED';
        this.transition(paused ? 'paused' : code === 'UNEXPECTED' ? 'error' : 'needs_user', code, acquired);
        return false;
      } finally {
        if (acquired && !signal.aborted) this.abort.abort(new TaskError('STOPPED'));
        if (acquired) this.media?.pause();
        this.media = null;
        this.ownsLock = false;
        this.running = false;
        this.onUpdate({ state: this.state, settled: true });
      }
    }
    async playMedia(signal) {
      this.transition('waiting_player', 'WAIT_PLAYER');
      const media = await waitFor(() => {
        this.guard(signal);
        const candidates = this.adapter.getMedia();
        if (candidates.length !== 1) return false;
        const candidate = candidates[0];
        if (candidate.error) fail('MEDIA_ERROR');
        return candidate.isConnected && candidate.readyState >= 2 ? candidate : false;
      }, { timeout: this.config.playerTimeout, interval: this.config.pollInterval, signal, code: 'PLAYER_TIMEOUT' });
      this.media = media;
      const checkMedia = () => {
        this.guard(signal);
        const candidates = this.adapter.getMedia();
        if (!media.isConnected || candidates.length !== 1 || candidates[0] !== media) fail('MEDIA_REPLACED');
        if (media.error) fail('MEDIA_ERROR');
      };
      checkMedia();
      if (media.ended) return;
      media.playbackRate = this.config.playbackRate;
      this.transition('starting', 'STARTING');
      const initialTime = media.currentTime;
      try {
        await boundedAction(() => {
          checkMedia();
          const promise = media.play();
          Promise.resolve(promise).then(() => {
            // play() 可能在取消或超时后才兑现，不能让旧请求重新开启播放。
            if ((signal.aborted || !this.running) && (!this.running || this.media !== media)) media.pause();
          }, () => {});
          return promise;
        }, this.config.startTimeout, signal);
      } catch (error) {
        if (signal.aborted || error instanceof TaskError) throw error;
        fail('PLAY_BLOCKED');
      }
      await waitFor(() => {
        checkMedia();
        return media.ended || (!media.paused && media.currentTime > initialTime);
      }, { timeout: this.config.startTimeout, interval: this.config.pollInterval, signal, code: 'START_TIMEOUT' });
      if (media.ended) return;
      this.transition('playing', 'PLAYING');
      let actualRate;
      let lastTime = media.currentTime;
      let lastAdvance = Date.now();
      await waitFor(() => {
        checkMedia();
        if (actualRate !== media.playbackRate) {
          actualRate = media.playbackRate;
          this.onUpdate({ state: this.state, actualRate });
        }
        if (media.ended) return true;
        if (media.paused) fail('PAUSE_DETECTED');
        if (media.currentTime > lastTime) lastAdvance = Date.now();
        lastTime = media.currentTime;
        if (Date.now() - lastAdvance >= this.config.stallTimeout) fail('STALLED');
        return false;
      }, { interval: this.config.pollInterval, signal });
    }
    async playCourseware(signal) {
      this.transition('courseware', 'COURSEWARE');
      let previousIndex = null;
      let total = null;
      for (;;) {
        this.guard(signal);
        const slide = this.adapter.getSlide();
        if (!slide || !Number.isInteger(slide.index) || !Number.isInteger(slide.total)
          || slide.index < 1 || slide.index > slide.total
          || (total !== null && slide.total !== total)
          || (previousIndex !== null && slide.index !== previousIndex + 1)) fail('SLIDE_INVALID');
        total = slide.total;
        if (this.adapter.getMedia().length) await this.playMedia(signal);
        this.transition('courseware', 'COURSEWARE');
        const started = Date.now();
        await waitFor(() => { this.guard(signal); return Date.now() - started >= this.config.pptInterval; }, {
          timeout: this.config.pptInterval + this.config.pollInterval * 2,
          interval: this.config.pollInterval, signal, code: 'SLIDE_TIMEOUT'
        });
        if (slide.index === slide.total) return;
        const next = slide.next;
        this.guard(signal);
        if (!isVisible(next) || next.ownerDocument !== this.doc || next.disabled
          || next.getAttribute('aria-disabled') === 'true') fail('SLIDE_INVALID');
        previousIndex = slide.index;
        next.click();
        await waitFor(() => { this.guard(signal); return this.adapter.getSlide()?.index !== slide.index; }, {
          timeout: this.config.switchTimeout, interval: this.config.pollInterval, signal, code: 'SLIDE_TIMEOUT'
        });
      }
    }
    async readCurrent(signal) {
      this.transition('courseware', 'COURSEWARE');
      const reading = await waitFor(() => {
        this.guard(signal);
        return this.adapter.getReading();
      }, { timeout: this.config.playerTimeout, interval: this.config.pollInterval, signal, code: 'RESOURCE_UNVERIFIED' });
      if (reading.pdf) {
        const ppt = this.route.leafId === this.course?.officeLeafId
          && officePptSource(reading.pdf.getAttribute('src'), this.course);
        await (ppt ? this.pptReader : this.pdfReader)(reading.pdf, { signal, config: this.config, course: this.course,
          guard: () => this.guard(signal), onPage: page => this.onUpdate({ state: this.state,
            ...(ppt ? { pptPage: page } : { pdfPage: page }) }) });
      }
      for (;;) {
        const started = Date.now();
        await waitFor(() => {
          this.guard(signal);
          if (!reading.node.isConnected) fail('MEDIA_REPLACED');
          return Date.now() - started >= this.config.pptInterval;
        }, { timeout: this.config.pptInterval + this.config.pollInterval * 2,
          interval: this.config.pollInterval, signal, code: 'SLIDE_TIMEOUT' });
        const scroll = reading.scrollContainer;
        if (!scroll || scroll.clientHeight <= 0) return;
        // 只浏览正文/附件区域，不滚动到其后的评论区。
        const bottom = Math.max(0, reading.node.offsetTop + reading.node.offsetHeight - scroll.clientHeight);
        const nextTop = Math.min(bottom, scroll.scrollTop + scroll.clientHeight * 0.8);
        if (nextTop <= scroll.scrollTop + 1) return;
        const previousTop = scroll.scrollTop;
        scroll.scrollTop = nextTop;
        if (scroll.scrollTop <= previousTop) fail('SLIDE_TIMEOUT');
      }
    }
  }


  function createPanel() {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '40px';
    iframe.style.left = '40px';
    iframe.style.width = '560px';
    iframe.style.height = '370px';
    iframe.style.zIndex = '999999';
    iframe.style.border = '1px solid #a3a3a3';
    iframe.style.borderRadius = '10px';
    iframe.style.background = '#fff';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '6px 4px 17px 2px #000000';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-playback-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) {
      throw new Error('面板挂载点不存在');
    }
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`
                  <style>
              /* 全局重置 */
              html, body { overflow: hidden; margin: 0; padding: 0; font-family: "Segoe UI", "PingFang SC", Avenir, Helvetica, Arial, sans-serif; color: #4a4a4a; background: transparent; }

              /* 主容器 */
              .mini-basic {
                position: absolute;
                inset: 0;
                background: #3a7afe;
                color: white;
                height: 100%;
                width: 100%;
                min-height: 42px;
                min-width: 42px;
                border-radius: 10px;
                text-align: center;
                line-height: 1;
                z-index: 1000000;
                cursor: pointer;
                display: none;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0);
              }
              .mini-basic.show {
                display: flex;
              }

              /* 面板主容器 */
              .panel {
                width: 100%;
                height: 100%;
                background: white;
                border-radius: 10px;
                position: relative;
                overflow: hidden;
              }

              /* 标题栏 */
              .header {
                text-align: center;
                height: 40px;
                background: #f7f7f7;
                color: #000;
                font-size: 18px;
                line-height: 40px;
                border-radius: 10px 10px 0 0;
                border-bottom: 2px solid #eee;
                cursor: move;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 10px;
              }
              .tools ul {
                margin: 0;
                padding: 0;
                list-style: none;
                display: flex;
                gap: 5px;
              }
              .tools li {
                display: inline-block;
                cursor: pointer;
                font-size: 14px;
                padding: 0 5px;
              }

              /* 内容区 */
              .body {
                font-weight: normal;
                font-size: 13px;
                line-height: 22px;
                height: calc(100% - 85px);
                overflow-y: auto;
                padding: 6px 8px;
                box-sizing: border-box;
              }

              .info {
                margin: 0;
                padding: 0;
                list-style: none;
              }
              .info li {
                margin-bottom: 4px;
                color: #333;
              }

              /* 设置面板 */
              #settings {
                display: none;
                position: absolute;
                top: 40px;
                left: 0;
                width: 100%;
                height: calc(100% - 40px);
                background: white;
                z-index: 99;
                padding: 15px;
                box-sizing: border-box;
                overflow-y: auto;
              }

              /* 表单项 */
              .form-item {
                margin-bottom: 15px;
              }
              .form-item label {
                display: block;
                margin-bottom: 5px;
                font-size: 12px;
                color: #333;
              }
              .form-item input[type="number"] {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 12px;
                box-sizing: border-box;
              }

              /* 复选框标签优化：避免“启用”跑到右边 */
              .form-item .checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                cursor: pointer;
              }
              .form-item .checkbox-label input[type="checkbox"] {
                margin: 0;
                width: auto;
              }

              /* 底部按钮栏 */
              .footer {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                background: #f7f7f7;
                color: #c5c5c5;
                font-size: 13px;
                line-height: 25px;
                border-radius: 0 0 10px 10px;
                border-bottom: 2px solid #eee;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 6px 0;
                gap: 10px;
              }
              .footer button {
                border: none;
                border-radius: 6px;
                color: white;
                cursor: pointer;
                padding: 6px 12px;
                font-size: 12px;
                transition: all 0.2s ease;
              }
              #btn-start {
                background-color: #1677ff;
              }
              #btn-start:hover {
                background-color: #f6ff00;
                color: black;
              }
              #btn-clear {
                background-color: #ff4d4f;
              }
              #btn-setting {
                background-color: #52c41a;
              }
              #btn-stop {
                background-color: #8c8c8c;
              }
              #btn-pause {
                background-color: #d46b08;
              }
              #btn-reload {
                background-color: #fa8c16;
              }

              /* 设置页底部按钮 */
              .settings-footer {
                text-align: center;
                margin-top: 12px;
                display: flex;
                justify-content: center;
                gap: 10px;
              }
              .settings-footer button {
                padding: 6px 15px;
                font-size: 12px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
              }
              #save_settings {
                background-color: #1677ff;
                color: white;
              }
              #close_settings {
                background-color: #999;
                color: white;
              }
            </style>

            <div class="mini-basic" id="mini-basic">展开</div>
            <div class="panel" id="panel">
              <div class="header" id="header">
                雨课堂刷课助手
                <div class='tools'>
                  <ul>
                    <li class='minimality' id="minimality">_</li>
                    <li class='question' id="question">?</li>
                  </ul>
                </div>
              </div>
              <div class="body">
                <ul class="info" id="info">
                  <li>请从具体资源页打开面板，遇到网页提示时手动处理。</li>
                  <li>进度核对和自动切换需要已核验的本地课堂配置。</li>
                  <li>作业、自测与讨论不自动处理；PDF 使用本机渲染逐页浏览。</li>
                  <li><button id="btn-readings">从当前图文连续浏览课件</button></li>
                  <li id="task-state" role="status" aria-live="polite">状态：空闲</li>
                  <hr>
                </ul>
              </div>
              <div id="settings">
                <div class="form-item">
                  <label for="playback-rate">播放倍速（0.5–3；默认 1）</label>
                  <input type="number" id="playback-rate" min="0.5" max="3" step="0.25" value="1">
                </div>
                <div class="form-item">
                  <label for="ppt-interval">课件每页间隔（1–60 秒）</label>
                  <input type="number" id="ppt-interval" min="1" max="60" step="1" value="3">
                </div>
                <p>仅使用网页正常播放器，不修改观看时间或平台完成度。页面暂停和人工提示需要手动处理。</p>
                <div class="settings-footer">
                  <button id="save_settings">保存并关闭</button>
                  <button id="close_settings">取消</button>
                </div>
              </div>
              <div class="footer">
                <button id="btn-setting">播放设置</button>
                <button id="btn-clear">清除日志</button>
                <button id="btn-start">开始播放</button>
                <button id="btn-pause">暂停</button>
                <button id="btn-stop">停止</button>
                <button id="btn-reload">恢复任务</button>
              </div>
            </div>
    `);
    doc.close();

    const ui = {
      iframe,
      doc,
      panel: doc.getElementById('panel'),
      header: doc.getElementById('header'),
      info: doc.getElementById('info'),
      btnStart: doc.getElementById('btn-start'),
      btnReadings: doc.getElementById('btn-readings'),
      btnClear: doc.getElementById('btn-clear'),
      btnSetting: doc.getElementById('btn-setting'),
      btnStop: doc.getElementById('btn-stop'),
      btnPause: doc.getElementById('btn-pause'),
      taskState: doc.getElementById('task-state'),
      btnReload: doc.getElementById('btn-reload'),
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      closeSettings: doc.getElementById('close_settings'),
      rateInput: doc.getElementById('playback-rate'),
      intervalInput: doc.getElementById('ppt-interval'),
      minimality: doc.getElementById('minimality'),
      question: doc.getElementById('question'),
      miniBasic: doc.getElementById('mini-basic')
    };

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const hostWindow = window.parent || window;
    const onMove = e => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      const maxLeft = Math.max(0, hostWindow.innerWidth - iframe.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - iframe.offsetHeight);
      iframe.style.left = Math.min(Math.max(0, startLeft + deltaX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + deltaY), maxTop) + 'px';
    };
    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
    };
    ui.header.addEventListener('mousedown', e => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      startLeft = parseFloat(iframe.style.left) || 0;
      startTop = parseFloat(iframe.style.top) || 0;
      iframe.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      e.preventDefault();
    });
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    const normalSize = { width: parseFloat(iframe.style.width), height: parseFloat(iframe.style.height) };
    const miniSize = 64;
    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.miniBasic.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    };
    ui.minimality.addEventListener('click', enterMini);
    ui.miniBasic.addEventListener('click', exitMini);

    ui.question.addEventListener('click', () => {
      window.parent.alert('原作者：风之子 / niuwh.cn；GPL3。本地审查改造版；真实页面适配未验证。');
    });

    const log = message => {
      const li = doc.createElement('li');
      li.innerText = message;
      ui.info.appendChild(li);
      while (ui.info.children.length > Config.logLimit + 6) ui.info.children[6].remove();
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const warn = message => {
      const li = doc.createElement('li');
      li.innerText = '⚠️警告：' + message;
      ui.info.appendChild(li);
      while (ui.info.children.length > Config.logLimit + 6) ui.info.children[6].remove();
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const error = message => {
      const li = doc.createElement('li');
      li.innerText = '🚨报错：' + message;
      ui.info.appendChild(li);
      while (ui.info.children.length > Config.logLimit + 6) ui.info.children[6].remove();
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const loadSettings = () => {
      ui.rateInput.value = controller.config.playbackRate;
      ui.intervalInput.value = controller.config.pptInterval / 1000;
    };
    ui.btnSetting.onclick = () => { loadSettings(); ui.settings.style.display = 'block'; };
    ui.closeSettings.onclick = () => { ui.settings.style.display = 'none'; };
    ui.saveSettings.onclick = () => {
      if (controller.setSettings({
        playbackRate: Number(ui.rateInput.value), pptInterval: Number(ui.intervalInput.value) * 1000
      })) { ui.settings.style.display = 'none'; log('播放设置已保存'); }
    };
    ui.btnClear.onclick = () => {
      controller.logs = [];
      Store.remove('logs');
      while (ui.info.children.length > 6) ui.info.lastElementChild.remove();
      log('本地日志已清除，任务记录保留');
    };
    ui.btnStart.onclick = () => { void controller.start(); };
    ui.btnReadings.onclick = () => { void controller.start({ readingsOnly: true }); };
    ui.btnPause.onclick = () => controller.pause();
    ui.btnStop.onclick = () => controller.stop();
    ui.btnReload.onclick = () => { void controller.restore(); };
    return {
      ...ui, log, warn, error,
      update(event) {
        ui.taskState.textContent = '状态：' + States[event.state];
        if (event.actualRate !== undefined) ui.taskState.textContent +=
          '；实际 ' + event.actualRate + '×（设置 ' + controller.config.playbackRate + '×）';
        if (event.pdfPage) ui.taskState.textContent += `；PDF ${event.pdfPage.index}/${event.pdfPage.total} 页`;
        if (event.pptPage) ui.taskState.textContent += `；PPT ${event.pptPage.index}/${event.pptPage.total} 页`;
        ui.btnStart.disabled = controller.running;
        ui.btnReadings.disabled = controller.running;
        ui.btnPause.disabled = !controller.running;
        ui.btnReload.disabled = controller.running || !controller.getRecovery();
        if (event.code) {
          const message = Messages[event.code];
          if (event.level === 'error') error(message);
          else if (event.level === 'warn') warn(message);
          else log(message);
        }
      }
    };
  }

  // Node 只导出离线可测接口；浏览器不会暴露这些接口到页面。
  if (typeof module === 'object' && module.exports) {
    module.exports = { Config, VerifiedCourse, Messages, States, getRoute, isProgressDone, isVisible,
      createAdapter, createStore, PlaybackController, validateSettings, pdfUrl, downloadPdf, browsePdf,
      officePptSource, officeFrameContext, officeSlide, pressOfficeButton, installOfficeParent, requestOffice, browseOfficePpt };
    return;
  }

  let panel, controller, Store;
  if (VerifiedCourse.officePath && officeFrameContext(location.href, document.referrer) && window.top !== window.self) {
    bootOfficeChild(window, document);
    return;
  }
  function boot() {
    const route = getRoute(location.href);
    if (window.top !== window.self || !route || document.getElementById('ykt-playback-iframe')) return;
    if (matchesVerifiedCourse(route, VerifiedCourse) && VerifiedCourse.officePath) installOfficeParent(window, document);
    Store = createStore({
      read: (key, fallback) => GM_getValue(key, fallback),
      write: (key, value) => GM_setValue(key, value),
      remove: key => GM_deleteValue(key),
      onError: () => { if (panel) panel.warn(Messages.STORAGE); }
    });
    try {
      panel = createPanel();
      controller = new PlaybackController({
        doc: document, href: () => location.href, locks: navigator.locks, store: Store,
        onUpdate: event => panel.update(event)
      });
      panel.log('本地审查版 v' + Config.version + '，当前路由：' + route.family);
      if (!Store.available) panel.warn(Messages.STORAGE);
      if (controller.getRecovery()) panel.log('有同一资源的恢复记录，可点击恢复任务重新核验');
      panel.update({ state: controller.state });
      window.addEventListener('pagehide', () => controller.pause());
    } catch (_) {
      if (panel) panel.error('面板初始化失败，请刷新后重试');
      else console.error('[雨课堂本地审查版] 面板初始化失败');
    }
  }
  boot();
})();
