'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { createAdapter, getRoute, PlaybackController, createStore } = require('../yuketang.js');
const { testCourse, memoryStore, locks } = require('./fixtures.cjs');

// 沿用已核验的 DOM 结构，课程标题和标识均为合成值。
function page() {
  const { document, HTMLElement } = parseHTML(`<!doctype html><html><body>
    <div class="learning-space-student"><div class="learning-space-student-knowledge-nav">
      <div class="nav-list">
        <div class="nav-item-node-inner"><i class="expand-icon"></i><span>知识点</span></div>
        <div class="nav-item-leaf-box"><div class="leaf-item" id="homework">
          <div class="leaf-item-tag">作业</div><div class="leaf-item-title">作业</div><div class="leaf-item-status"></div>
        </div></div>
        <div class="nav-item-leaf-box"><div class="leaf-item is-active" id="current">
          <div class="leaf-item-tag">视频</div><div class="leaf-item-title">合成视频一</div><div class="leaf-item-status"></div>
        </div></div>
        <div class="nav-item-leaf-box"><div class="leaf-item" id="reading">
          <div class="leaf-item-tag">图文</div><div class="leaf-item-title">合成课件</div>
          <div class="leaf-item-status"><i class="icon iconfont icon-yuanquangou"></i></div>
        </div></div>
        <div class="nav-item-leaf-box"><div class="leaf-item" id="next">
          <div class="leaf-item-tag">视频</div><div class="leaf-item-title">合成视频二</div><div class="leaf-item-status"></div>
        </div></div>
        <div class="nav-item-leaf-box"><div class="leaf-item" id="selftest">
          <div class="leaf-item-tag">自测</div><div class="leaf-item-title">自测</div><div class="leaf-item-status"></div>
        </div></div>
      </div>
    </div><div class="content-detail"><div class="learning-space-video"><div class="video-box">
      <video id="course-video"></video>
    </div></div></div><div class="tts-player__container"><audio id="chat-audio"></audio></div></div>
  </body></html>`, {
    getComputedStyle: node => ({ display: node.style.display || 'block',
      visibility: node.style.visibility || 'visible', opacity: node.style.opacity || '1' })
  });
  HTMLElement.prototype.getBoundingClientRect = function () { return { width: 100, height: 30 }; };
  document.visibilityState = 'visible';
  // 补足合成目录中已完成的资源，用于检验目录数量约束。
  const nav = document.querySelector('.nav-list');
  for (let index = 0; index < testCourse.resourceCount - 3; index++) {
    const node = document.createElement('div');
    node.className = 'nav-item-leaf-box';
    node.innerHTML = `<div class="leaf-item"><div class="leaf-item-tag">图文</div>
      <div class="leaf-item-title">已完成课件 ${index}</div><div class="leaf-item-status">
      <i class="icon iconfont icon-yuanquangou"></i></div></div>`;
    nav.appendChild(node);
  }
  const state = { href: 'https://www.yuketang.cn/ai-workspace/lms-graph/demo-class/video/demo-first' };
  const route = getRoute(state.href);
  const adapter = createAdapter(route, document, () => state.href, testCourse);
  const store = memoryStore(createStore).store;
  const controller = new PlaybackController({ doc: document, href: () => state.href, locks: locks(), store, course: testCourse });
  Object.assign(controller, { route, adapter, lessonKey: route.key });
  return { document, state, route, adapter, controller };
}
function complete(doc, id) {
  doc.querySelector(`#${id} .leaf-item-status`).innerHTML = '<i class="icon iconfont icon-yuanquangou"></i>';
}

test('真实结构选择器只绑定课程视频，排除 AI 聊天的 TTS audio', () => {
  const f = page();
  assert.equal(f.adapter.verified, true);
  assert.deepEqual(f.adapter.getMedia().map(node => node.id), ['course-video']);
});

test('课程完成只能来自当前叶节点的可见完成图标', () => {
  const f = page();
  assert.equal(f.controller.isComplete(), false);
  complete(f.document, 'next');
  assert.equal(f.controller.isComplete(), false);
  complete(f.document, 'current');
  assert.equal(f.controller.isComplete(), true);
  f.document.querySelector('#current .icon-yuanquangou').style.visibility = 'hidden';
  assert.equal(f.controller.isComplete(), false);
});

test('未完成、近似图标或非当前资源不会产生完成证据', () => {
  const f = page();
  f.document.querySelector('#current .leaf-item-status').innerHTML = '<i class="icon-yuanquangou-pending"></i>';
  assert.equal(f.controller.isComplete(), false);
  complete(f.document, 'current');
  f.document.querySelector('#current').classList.remove('is-active');
  assert.equal(f.controller.isComplete(), false);
});

test('下一节只选择支持类型，跳过作业和自测', () => {
  const f = page();
  complete(f.document, 'current');
  assert.equal(f.adapter.getNext().node.id, 'next');
  complete(f.document, 'next');
  assert.equal(f.adapter.getNext().end, true);
});

test('导航资源切换必须同时匹配目标标题与新路径', () => {
  const f = page();
  const next = f.adapter.getNext();
  next.beforeClick();
  f.state.href = 'https://www.yuketang.cn/ai-workspace/lms-graph/demo-class/video/demo-next';
  assert.equal(f.adapter.getLessonKey(), '');
  f.document.querySelector('#current').classList.remove('is-active');
  f.document.querySelector('#next').classList.add('is-active');
  assert.equal(f.adapter.getLessonKey(), getRoute(f.state.href).key);
  f.state.href = 'https://www.yuketang.cn/ai-workspace/lms-graph/other-class/video/demo-next';
  assert.equal(f.adapter.getLessonKey(), '');
});

test('多个活动叶节点以及其他课堂均保持保守状态', () => {
  const f = page();
  f.document.querySelector('#next').classList.add('is-active');
  assert.equal(f.adapter.getLessonKey(), '');
  assert.deepEqual(f.adapter.getMedia(), []);
  const other = createAdapter(getRoute('https://www.yuketang.cn/ai-workspace/lms-graph/other-class/video/demo-first'),
    f.document, () => f.state.href, testCourse);
  assert.equal(other.verified, false);
  const unconfigured = createAdapter(f.route, f.document);
  assert.equal(unconfigured.verified, false);
  assert.deepEqual(unconfigured.getMedia().map(node => node.id), ['course-video']);
  assert.equal(createAdapter(f.route, f.document, () => f.state.href, { ...testCourse, resourceCount: 0 }).verified, false);
});

test('展开只操作导航图标，不触发资源选择', async () => {
  const f = page();
  let clickedResources = 0;
  for (const node of f.document.querySelectorAll('.leaf-item')) node.addEventListener('click', () => clickedResources++);
  f.document.querySelector('.expand-icon').addEventListener('click', event => event.currentTarget.classList.add('is-expanded'));
  await f.adapter.prepare(new AbortController().signal, { switchTimeout: 20, pollInterval: 1 });
  assert.equal(clickedResources, 0);
  assert.ok(f.document.querySelector('.expand-icon.is-expanded'));
});

test('作业和其他路由在取得真实页面证据前不误启用适配', () => {
  const f = page();
  for (const href of ['https://www.yuketang.cn/ai-workspace/lms-graph/demo-class/exercise/demo-exercise',
    'https://www.yuketang.cn/pro/lms/123/studycontent',
    'https://www.yuketang.cn/v2/web/studentLog/demo-class']) {
    assert.equal(createAdapter(getRoute(href), f.document, () => href, testCourse).verified, false);
  }
});

function graphPage() {
  const f = page();
  f.document.querySelector('#current').classList.remove('is-active');
  f.document.querySelector('#reading').classList.add('is-active');
  f.document.querySelector('.content-detail').innerHTML = `<div class="lms-graph-article"><div class="graph-wrap">
    <div class="learning-space-control-unit"><div class="unit-title">合成课件</div>
      <div class="control-right"><div class="f12 color-9b">已读</div></div></div>
    <div class="scroll-container"><div class="main-text-attachment"><p>课件正文</p>
      <div class="preview-content"><iframe title="合成 PDF 附件"></iframe></div></div>
      <div class="module-forum">评论区不参与浏览</div></div>
  </div></div>`;
  f.state.href = 'https://www.yuketang.cn/ai-workspace/lms-graph/demo-class/graph/demo-reading';
  f.route = getRoute(f.state.href);
  f.adapter = createAdapter(f.route, f.document, () => f.state.href, testCourse);
  Object.assign(f.controller, { route: f.route, adapter: f.adapter, lessonKey: f.route.key });
  const scroll = f.document.querySelector('.scroll-container');
  Object.defineProperties(scroll, { clientHeight: { value: 300 }, scrollTop: { value: 0, writable: true } });
  Object.defineProperties(f.document.querySelector('.main-text-attachment'), {
    offsetTop: { value: 0 }, offsetHeight: { value: 200 }
  });
  f.document.querySelector('.expand-icon').classList.add('is-expanded');
  return f;
}

test('真实图文结构要求页面已读标签与当前资源完成图标同时存在', () => {
  const f = graphPage();
  assert.equal(f.adapter.verified, true);
  assert.equal(f.adapter.getKind(), 'reading');
  assert.equal(f.controller.isComplete(), true);
  f.document.querySelector('.color-9b').textContent = '未读';
  assert.equal(f.controller.isComplete(), false);
  f.document.querySelector('.color-9b').textContent = '已读';
  f.document.querySelector('#reading .icon-yuanquangou').remove();
  assert.equal(f.controller.isComplete(), false);
});

test('图文正文必须绑定活动资源，评论区不属于阅读节点', () => {
  const f = graphPage();
  assert.equal(f.adapter.getReading().node.className, 'main-text-attachment');
  assert.ok(!f.adapter.getReading().node.contains(f.document.querySelector('.module-forum')));
  f.document.querySelector('.unit-title').textContent = '其他课件';
  assert.equal(f.adapter.getReading(), null);
  assert.equal(f.adapter.getCompletion(), null);
});

test('图文附件有多个 iframe 时不猜测需要翻页的对象', () => {
  const f = graphPage();
  const iframe = f.document.querySelector('iframe');
  iframe.after(iframe.cloneNode(true));
  assert.throws(() => f.adapter.getReading(), { code: 'RESOURCE_UNVERIFIED' });
});

test('图文存在 PDF 时先等待逐页浏览，再确认平台进度', async () => {
  const f = graphPage();
  complete(f.document, 'current');
  complete(f.document, 'next');
  let browsed = false;
  const controller = new PlaybackController({ doc: f.document, href: () => f.state.href,
    course: testCourse,
    pdfReader: async iframe => { assert.equal(iframe.tagName, 'IFRAME'); browsed = true; },
    locks: locks(), store: memoryStore(createStore).store,
    config: { pptInterval: 2, pollInterval: 1, playerTimeout: 50 } });
  assert.equal(await controller.start(), true);
  assert.equal(controller.state, 'completed');
  assert.equal(browsed, true);
  assert.equal(f.document.querySelector('.scroll-container').scrollTop, 0);
  assert.equal(f.document.querySelector('iframe').getAttribute('src'), null);
});

test('已取证Office原生PPT分派到原生翻页器，不错误送入PDF解析器', async () => {
  const f = graphPage();
  f.document.querySelector('iframe').setAttribute('src', 'https://view.officeapps.live.com/op/embed.aspx?src=' +
    encodeURIComponent('https://qn1-next.xuetangonline.com' + testCourse.officePath));
  complete(f.document, 'current');
  complete(f.document, 'next');
  let browsed = false;
  const controller = new PlaybackController({ doc: f.document, href: () => f.state.href,
    course: testCourse,
    locks: locks(), store: memoryStore(createStore).store, config: { pptInterval: 1, pollInterval: 1 },
    pdfReader: async () => { throw Error('不应解析PDF'); }, pptReader: async () => { browsed = true; } });
  assert.equal(await controller.start(), true);
  assert.equal(browsed, true);
});

test('下一节保留未读课件，不能只处理视频后声称全部完成', () => {
  const f = page();
  complete(f.document, 'current');
  complete(f.document, 'next');
  f.document.querySelector('#reading .icon-yuanquangou').remove();
  assert.equal(f.adapter.getNext().node.id, 'reading');
  assert.notEqual(f.adapter.getNext().end, true);
});

test('目录加载不全不能判断课程终点', () => {
  const f = page();
  complete(f.document, 'current');
  complete(f.document, 'next');
  f.document.querySelector('#reading').remove();
  assert.equal(f.adapter.getNext(), null);
});

test('同类型同名资源存在歧义时不允许自动切换', () => {
  const f = page();
  f.document.querySelector('#next .leaf-item-title').textContent = '合成视频一';
  assert.equal(f.adapter.getNext(), null);
});

test('已准备的目录被重建时不点击旧节点，重新准备后才能继续', async () => {
  const f = page();
  f.document.querySelector('.expand-icon').classList.add('is-expanded');
  const signal = new AbortController().signal;
  const config = { playerTimeout: 20, switchTimeout: 20, pollInterval: 1 };
  await f.adapter.prepare(signal, config);
  const oldNav = f.document.querySelector('.nav-list');
  const newNav = oldNav.cloneNode(true);
  oldNav.replaceWith(newNav);
  assert.equal(f.adapter.getNext(), null);
  await f.adapter.prepare(signal, config);
  assert.equal(f.adapter.getNext().node, newNav.querySelector('#next'));
});

test('准备后的终点仍核对完整目录，不把新增未完成项漏报为完成', async () => {
  const f = page();
  complete(f.document, 'current');
  complete(f.document, 'next');
  f.document.querySelector('.expand-icon').classList.add('is-expanded');
  await f.adapter.prepare(new AbortController().signal, {
    playerTimeout: 20, switchTimeout: 20, pollInterval: 1
  });
  const extra = f.document.querySelector('#next').parentElement.cloneNode(true);
  extra.querySelector('.leaf-item-title').textContent = '新增未完成项';
  extra.querySelector('.icon-yuanquangou').remove();
  f.document.querySelector('.nav-list').appendChild(extra);
  assert.equal(f.adapter.getNext(), null);
});

test('正文按实际高度浏览，滚动不推进时停止', async () => {
  for (const stuck of [false, true]) {
    const f = graphPage();
    const oldScroll = f.document.querySelector('.scroll-container');
    const scroll = oldScroll.cloneNode(true);
    oldScroll.replaceWith(scroll);
    const longBody = scroll.querySelector('.main-text-attachment');
    Object.defineProperties(longBody, { offsetTop: { value: 0 }, offsetHeight: { value: 130000 } });
    Object.defineProperty(scroll, 'clientHeight', { value: 300 });
    Object.defineProperty(scroll, 'scrollTop', stuck ? { get: () => 0, set: () => {} }
      : { value: 0, writable: true });
    const controller = new PlaybackController({ doc: f.document, href: () => f.state.href,
      course: testCourse,
      pdfReader: async () => {},
      locks: locks(), store: memoryStore(createStore).store,
      config: { pptInterval: 0, pollInterval: 1 } });
    Object.assign(controller, { route: f.route, adapter: f.adapter, lessonKey: f.route.key });
    if (stuck) await assert.rejects(controller.readCurrent(new AbortController().signal), { code: 'SLIDE_TIMEOUT' });
    else {
      await controller.readCurrent(new AbortController().signal);
      assert.equal(scroll.scrollTop, 129700);
    }
  }
});

test('课件复看只按目录顺序选择后续图文，保留已读项且跳过视频作业', () => {
  const f = graphPage();
  const next = f.adapter.getNext({ readingsOnly: true });
  assert.equal(next.node.querySelector('.leaf-item-title').textContent.trim(), '已完成课件 0');
  f.document.querySelector('#reading').classList.remove('is-active');
  const last = [...f.document.querySelectorAll('.leaf-item')].at(-1);
  last.classList.add('is-active');
  assert.equal(f.adapter.getNext({ readingsOnly: true }).end, true);
});

test('课件复看沿已读图文连续推进，暂停恢复保留模式，不播放尚未完成的视频', async () => {
  const f = graphPage();
  const graphs = [...f.document.querySelectorAll('.leaf-item')].filter(node =>
    node.querySelector('.leaf-item-tag').textContent.trim() === '图文');
  for (const [index, node] of graphs.entries()) node.addEventListener('click', () => {
    f.document.querySelector('.leaf-item.is-active').classList.remove('is-active');
    node.classList.add('is-active');
    f.document.querySelector('.content-detail .unit-title').textContent = node.querySelector('.leaf-item-title').textContent;
    f.state.href = `https://www.yuketang.cn/ai-workspace/lms-graph/demo-class/graph/demo-graph-${index}`;
  });
  const reads = [];
  let pauseOnce = true;
  const controller = new PlaybackController({ doc: f.document, href: () => f.state.href,
    course: testCourse,
    locks: locks(), store: memoryStore(createStore).store,
    config: { pptInterval: 0, pollInterval: 1, playerTimeout: 50, switchTimeout: 50 },
    pdfReader: async () => {
      reads.push(f.document.querySelector('.content-detail .unit-title').textContent.trim());
      if (pauseOnce) { pauseOnce = false; controller.pause(); }
    }
  });
  assert.equal(await controller.start({ readingsOnly: true }), false);
  assert.equal(controller.getRecovery().readingsOnly, true);
  assert.equal(await controller.restore(), true);
  assert.equal(controller.state, 'completed');
  assert.deepEqual(reads.slice(1), graphs.map(node => node.querySelector('.leaf-item-title').textContent.trim()));
  assert.equal(f.document.querySelector('#current .icon-yuanquangou'), null);
  assert.equal(f.document.querySelector('#next .icon-yuanquangou'), null);
});
