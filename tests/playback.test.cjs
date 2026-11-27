'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { getRoute, isProgressDone, isVisible, createAdapter, createStore,
  PlaybackController } = require('../yuketang.js');
const { Element, Media, Document, paths, memoryStore, locks, fixture } = require('./fixtures.cjs');

const fast = {
  pollInterval: 1, playerTimeout: 70, startTimeout: 70,
  stallTimeout: 40, progressTimeout: 40, switchTimeout: 40,
  pptInterval: 2
};
function make(f = fixture(), options = {}) {
  const storage = options.storage || memoryStore(createStore);
  const events = [];
  const controller = new PlaybackController({
    doc: f.doc, href: () => f.state.href, locks: options.locks || locks(), store: storage.store,
    adapterFactory: () => f.adapter, config: { ...fast, ...options.config },
    onUpdate: event => { events.push(event); options.onUpdate?.(event, controller); }
  });
  return { f, storage, events, controller };
}
const lastCode = run => run.events.filter(event => event.code).at(-1)?.code;

test('仅识别目标 HTTPS 域名的三类路由；不会持久化任意查询参数', () => {
  for (const [family, path] of Object.entries(paths)) {
    const url = new URL('https://www.yuketang.cn' + path);
    url.searchParams.set('token', 'secret');
    const route = getRoute(url.href);
    assert.equal(route.family, family);
    assert.ok(!route.key.includes('secret'));
    assert.ok(!route.key.includes('token'));
  }
  for (const href of ['http://www.yuketang.cn/v2/web/1', 'https://evil.example/v2/web/1',
    'https://www.yuketang.cn.evil.example/v2/web/1', 'https://other.yuketang.cn/v2/web/1',
    'https://www.yuketang.cn/v2/webbing/1', 'not a URL']) assert.equal(getRoute(href), null);
  const ai = getRoute('https://www.yuketang.cn/ai-workspace/lms-graph/c/audio/l?node_id=n');
  assert.equal(ai.classroomId, 'c');
  assert.equal(ai.type, 'audio');
  assert.equal(ai.leafId, 'l');
});

test('只有明确完成文本可作为进度证据', () => {
  for (const text of ['100%', '100.00%', '已完成', '已读', ' 3 / 3 ']) assert.equal(isProgressDone(text), true, text);
  for (const text of ['98%', '99%', '未完成', '未全部完成', '0/0', '1/2', '1100%',
    '已完成1/2', '完成时间100%', '00:10 / 00:10', '9007199254740993/9007199254740993', '', null]) {
    assert.equal(isProgressDone(text), false, String(text));
  }
});

for (const family of Object.keys(paths)) {
  test(`${family}：生产适配未验证；正常播放后不推断完成或点击下一节`, async () => {
    const f = fixture(family);
    f.adapter = createAdapter(getRoute(f.state.href), f.doc);
    const run = make(f);
    assert.equal(await run.controller.start(), false);
    assert.equal(run.controller.state, 'needs_user');
    assert.equal(lastCode(run), 'PROGRESS_UNVERIFIED');
    assert.equal(f.media.plays, 1);
    assert.equal(f.next.clicks, 0);
    assert.equal(f.media.playbackRate, 1);
  });
  test(`${family}：模拟 DOM 明确完成后只点击一次并确认新资源，再确认终点`, async () => {
    const f = fixture(family);
    const second = new Media(f.doc);
    second.onEnd = () => { f.progress.innerText = '已完成'; };
    f.adapter.getNext = () => f.state.lesson === 'lesson-1'
      ? { verified: true, lessonKey: f.state.lesson, node: f.next }
      : { verified: true, lessonKey: f.state.lesson, end: true };
    f.next.onClick = () => {
      f.state.lesson = 'lesson-2';
      f.progress.innerText = '0%';
      f.doc.media = [second];
    };
    const run = make(f);
    assert.equal(await run.controller.start(), true);
    assert.equal(run.controller.state, 'completed');
    assert.equal(f.next.clicks, 1);
    assert.equal(second.plays, 1);
    assert.equal(run.storage.store.get('checkpoint'), null);
  });
}

test('播放器延迟出现及元数据/缓冲加载后才调用 play', async () => {
  const f = fixture();
  f.doc.media = [];
  f.media.readyState = 0;
  const run = make(f);
  const task = run.controller.start();
  setTimeout(() => { f.doc.media = [f.media]; }, 5);
  setTimeout(() => { assert.equal(f.media.plays, 0); f.media.readyState = 4; }, 10);
  assert.equal(await task, true);
});

test('没有播放器、多个播放器、元数据不加载都有限时停止', async () => {
  for (const kind of ['missing', 'multiple', 'unready']) {
    const f = fixture();
    if (kind === 'missing') f.doc.media = [];
    if (kind === 'multiple') f.doc.media.push(new Media(f.doc));
    if (kind === 'unready') f.media.readyState = 0;
    const run = make(f, { config: { playerTimeout: 10 } });
    assert.equal(await run.controller.start(), false);
    assert.equal(lastCode(run), 'PLAYER_TIMEOUT');
    assert.equal(f.next.clicks, 0);
  }
});

test('浏览器拒播不自动重试，不把异常内容写入日志', async () => {
  const run = make(fixture('pro/lms', { mode: 'reject' }));
  await run.controller.start();
  assert.equal(lastCode(run), 'PLAY_BLOCKED');
  assert.equal(run.f.media.plays, 1);
  assert.ok(!JSON.stringify([...run.storage.data.values()]).includes('sensitive key'));
});

test('悬挂 play() 超时后迟到的兑现不能重启播放', async () => {
  const run = make(fixture('v2/web', { mode: 'pending' }), { config: { startTimeout: 10 } });
  await run.controller.start();
  assert.equal(lastCode(run), 'START_TIMEOUT');
  run.f.media.resolvePlay();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.f.media.paused, true);
});

test('开始时间不推进和开始后卡顿分别受超时限制', async () => {
  const start = make(fixture('v2/web', { mode: 'stall' }), { config: { startTimeout: 10 } });
  await start.controller.start();
  assert.equal(lastCode(start), 'START_TIMEOUT');
  const stall = make(fixture('v2/web', { mode: 'continuous' }), {
    onUpdate(event, controller) {
      if (event.state === 'playing') clearInterval(controller.media.timer);
    }, config: { stallTimeout: 10 }
  });
  await stall.controller.start();
  assert.equal(lastCode(stall), 'STALLED');
});

test('暂停可取消等待；恢复重新核验，不写 currentTime', async () => {
  const run = make(fixture('v2/web', { mode: 'continuous' }), {
    onUpdate(event, controller) { if (event.state === 'playing') controller.pause(); }
  });
  await run.controller.start();
  assert.equal(run.controller.state, 'paused');
  assert.ok(run.controller.getRecovery());
  const currentTime = run.f.media.currentTime;
  const restored = new PlaybackController({
    doc: run.f.doc, href: () => run.f.state.href, locks: locks(), store: run.storage.store,
    adapterFactory: () => run.f.adapter, config: fast
  });
  run.f.media.mode = 'end';
  assert.equal(run.f.media.currentTime, currentTime);
  assert.equal(await restored.restore(), true);
});

test('播放轮询不重复保存恢复阶段，旧同资源记录仍可人工恢复', async () => {
  const run = make(fixture('v2/web', { mode: 'continuous' }), {
    onUpdate(event, controller) {
      if (event.state !== 'playing') return;
      const checkpoint = controller.store.get('checkpoint');
      const writes = run.storage.calls.length;
      controller.guard(controller.abort.signal);
      assert.equal(run.storage.calls.length, writes);
      assert.equal(checkpoint.state, 'playing');
      assert.deepEqual(Object.keys(checkpoint).sort(), ['readingsOnly', 'route', 'state', 'taskId', 'ts', 'version']);
      assert.equal(checkpoint.readingsOnly, false);
      controller.pause();
    }
  });
  await run.controller.start();
  assert.equal(run.controller.state, 'paused');
  const saved = run.storage.store.get('checkpoint');
  saved.ts = Date.now() - 24 * 60 * 60 * 1000;
  run.storage.store.set('checkpoint', saved);
  assert.ok(run.controller.getRecovery());
});

test('等待播放器时停止，会立即取消轮询并清除本任务恢复记录', async () => {
  const f = fixture();
  f.doc.media = [];
  const run = make(f, { onUpdate(event, controller) {
    if (event.state === 'waiting_player') queueMicrotask(() => controller.stop());
  } });
  await run.controller.start();
  assert.equal(run.controller.state, 'stopped');
  assert.equal(run.storage.store.get('checkpoint'), null);
  assert.equal(run.controller.running, false);
});

test('网页暂停和资源地址改变不会被强制恢复', async () => {
  for (const kind of ['paused', 'route']) {
    const run = make(fixture('v2/web', { mode: 'continuous' }), {
      onUpdate(event, controller) {
        if (event.state !== 'playing') return;
        if (kind === 'paused') controller.media.pause();
        if (kind === 'route') run.f.state.href = 'https://www.yuketang.cn/v2/web/studentLog/other';
      }
    });
    await run.controller.start();
    assert.equal(run.controller.state, 'paused');
    assert.equal(run.f.media.plays, 1);
    assert.equal(run.f.next.clicks, 0);
  }
});

test('页面隐藏本身不打断正常播放，也不覆盖浏览器可见性', async () => {
  const run = make(fixture(), { onUpdate(event, controller) {
    if (event.code === 'PLAYING') controller.doc.visibilityState = 'hidden';
  } });
  assert.equal(await run.controller.start(), true);
  assert.equal(run.f.doc.visibilityState, 'hidden');
  assert.equal(run.f.media.plays, 1);
});

test('平台重置倍速后反馈实际值，不反复强制设置', async () => {
  const rates = [];
  const run = make(fixture(), { config: { playbackRate: 2 }, onUpdate(event, controller) {
    if (event.code === 'PLAYING') controller.media.playbackRate = 1.25;
    if (event.actualRate !== undefined) {
      rates.push(event.actualRate);
      if (event.actualRate === 1.25) controller.media.playbackRate = 1;
    }
  } });
  assert.equal(await run.controller.start(), true);
  assert.deepEqual(rates, [1.25, 1]);
  assert.equal(run.f.media.playbackRate, 1);
});

test('ended、99%、隐藏节点及其他资源的完成节点均不允许推进', async () => {
  for (const kind of ['99%', 'hidden', 'stale', 'missing']) {
    const f = fixture();
    f.media.onEnd = () => { f.progress.innerText = kind === '99%' ? '99%' : '100%'; };
    f.adapter.getNext = () => ({ verified: true, lessonKey: f.state.lesson, node: f.next });
    if (kind === 'hidden') f.progress.hidden = true;
    if (kind === 'stale') f.adapter.getCompletion = () => ({ node: f.progress, lessonKey: 'other-lesson' });
    if (kind === 'missing') f.adapter.getCompletion = () => null;
    const run = make(f, { config: { progressTimeout: 10 } });
    await run.controller.start();
    assert.equal(lastCode(run), 'PROGRESS_TIMEOUT', kind);
    assert.equal(f.next.clicks, 0, kind);
  }
});

test('结束后等待页面真实进度更新，而不是立即递增本地完成度', async () => {
  const f = fixture();
  f.media.onEnd = () => { setTimeout(() => { f.progress.innerText = '100%'; }, 10); };
  const run = make(f);
  assert.equal(await run.controller.start(), true);
  assert.ok(run.events.some(event => event.state === 'waiting_progress'));
});

test('下一节未验证、禁用或没有完成切换均不反复点击', async () => {
  for (const kind of ['unverified', 'disabled', 'no-change']) {
    const f = fixture();
    f.progress.innerText = '100%';
    f.next.disabled = kind === 'disabled';
    f.adapter.getNext = () => ({ verified: kind !== 'unverified', lessonKey: f.state.lesson, node: f.next });
    const run = make(f, { config: { switchTimeout: 10 } });
    await run.controller.start();
    assert.equal(lastCode(run), kind === 'no-change' ? 'SWITCH_TIMEOUT' : 'NEXT_UNVERIFIED');
    assert.equal(f.next.clicks, kind === 'no-change' ? 1 : 0);
  }
});

test('章节循环仍会停止，不依赖固定资源数量上限', async () => {
  const f = fixture();
  f.progress.innerText = '100%';
  f.adapter.getNext = () => ({ verified: true, lessonKey: f.state.lesson, node: f.next });
  f.next.onClick = () => { f.state.lesson = f.state.lesson === 'lesson-1' ? 'lesson-2' : 'lesson-1'; };
  const run = make(f);
  await run.controller.start();
  assert.equal(lastCode(run), 'CYCLE');
  assert.equal(f.next.clicks, 2);
});

test('同一控制器重复启动和多标签页任务锁', async () => {
  const sharedLocks = locks();
  const sharedStorage = memoryStore(createStore);
  const first = make(fixture('v2/web', { mode: 'continuous' }), { locks: sharedLocks, storage: sharedStorage });
  first.f.doc.media = [];
  const second = make(fixture('pro/lms'), { locks: sharedLocks, storage: sharedStorage });
  const task = first.controller.start();
  const checkpoint = sharedStorage.store.get('checkpoint');
  assert.equal(await first.controller.start(), false);
  assert.equal(await second.controller.start(), false);
  assert.equal(lastCode(second), 'LOCKED');
  assert.deepEqual(sharedStorage.store.get('checkpoint'), checkpoint);
  second.controller.stop();
  assert.deepEqual(sharedStorage.store.get('checkpoint'), checkpoint);
  first.controller.stop();
  await task;
});

test('缺少浏览器锁时不启动，锁异常有固定错误提示', async () => {
  const run = make(fixture(), { locks: {} });
  await run.controller.start();
  assert.equal(lastCode(run), 'LOCK_UNAVAILABLE');
  assert.equal(run.f.media.plays, 0);
  const failed = make(fixture(), { locks: { request: async () => { throw new Error('private detail'); } } });
  await failed.controller.start();
  assert.equal(lastCode(failed), 'UNEXPECTED');
});

test('等待获取锁时暂停，不覆盖另一任务的恢复记录', async () => {
  const storage = memoryStore(createStore);
  const checkpoint = { version: 1, taskId: 'active-other-tab', route: 'other-resource', state: 'playing', ts: Date.now() };
  storage.store.set('checkpoint', checkpoint);
  let resolveLock;
  const pendingLocks = { request: () => new Promise(resolve => { resolveLock = resolve; }) };
  const run = make(fixture(), { storage, locks: pendingLocks });
  // 此控制器之前运行过，有旧的 taskId；现在没有取得锁。
  run.controller.taskId = 'previous-local-task';
  run.controller.route = getRoute(run.f.state.href);
  const task = run.controller.start();
  run.controller.pause();
  assert.deepEqual(storage.store.get('checkpoint'), checkpoint);
  resolveLock(false);
  await task;
});

test('取得任务锁前已离开支持路由时正常暂停，不产生未处理异常', async () => {
  const delayedLocks = { async request(name, options, callback) {
    await new Promise(resolve => setImmediate(resolve));
    return callback({ name });
  } };
  const run = make(fixture(), { locks: delayedLocks });
  const task = run.controller.start();
  run.f.state.href = 'https://www.yuketang.cn/login';
  assert.equal(await task, false);
  assert.equal(lastCode(run), 'ROUTE_CHANGED');
  assert.equal(run.controller.running, false);
  assert.equal(run.f.media.plays, 0);
});

test('错误资源的下一节节点与已撤回的完成状态不能触发点击', async () => {
  for (const kind of ['stale-next', 'revoked']) {
    const f = fixture();
    f.progress.innerText = '100%';
    f.adapter.getNext = () => ({ verified: true,
      lessonKey: kind === 'stale-next' ? 'other-lesson' : f.state.lesson, node: f.next });
    const run = make(f, { onUpdate(event) {
      if (kind === 'revoked' && event.state === 'switching') f.progress.innerText = '99%';
    } });
    await run.controller.start();
    assert.equal(lastCode(run), kind === 'stale-next' ? 'NEXT_UNVERIFIED' : 'PROGRESS_TIMEOUT');
    assert.equal(f.next.clicks, 0);
  }
});

test('正在播放的元素被替换或报错时停止，不重试其他媒体', async () => {
  for (const kind of ['replace', 'error']) {
    const f = fixture('v2/web', { mode: 'continuous' });
    const run = make(f, { onUpdate(event) {
      if (event.state !== 'playing') return;
      if (kind === 'replace') f.doc.media = [new Media(f.doc)];
      else f.media.error = { code: 3 };
    } });
    await run.controller.start();
    assert.equal(lastCode(run), kind === 'replace' ? 'MEDIA_REPLACED' : 'MEDIA_ERROR');
    assert.equal(f.next.clicks, 0);
  }
});

test('存储写失败时保留内存记录，设置只复制已校验的两个字段', () => {
  let warnings = 0;
  const store = createStore({ read: (_, fallback) => fallback,
    write() { throw new Error('quota'); }, onError() { warnings++; } });
  const run = make(fixture(), { storage: { store } });
  run.controller.setSettings({ playbackRate: 2, pptInterval: 3000, playerTimeout: Infinity });
  assert.equal(warnings, 1);
  assert.equal(store.available, false);
  assert.equal(run.controller.config.playerTimeout, fast.playerTimeout);
  assert.deepEqual(store.get('settings'), { playbackRate: 2, pptInterval: 3000 });
  store.remove('settings');
  assert.equal(store.get('settings'), null);
});

test('损坏、不同资源或不可恢复阶段的记录被拒绝', async () => {
  const run = make();
  const base = { version: 1, taskId: 'fixture-task', route: getRoute(run.f.state.href).key, state: 'playing', ts: Date.now() };
  for (const saved of [null, {}, 'invalid', { ...base, taskId: '' },
    { ...base, route: 'other' }, { ...base, state: 'completed' }]) {
    run.storage.store.set('checkpoint', saved);
    assert.equal(run.controller.getRecovery(), null);
  }
  assert.equal(await run.controller.restore(), false);
});

test('设置输入边界校验，旧 AI 开关和 Key 不被读取', () => {
  const run = make();
  for (const rate of [0, -1, 4, NaN, Infinity, '2']) assert.equal(run.controller.setSettings({ playbackRate: rate, pptInterval: 3000 }), false);
  for (const interval of [0, 999, 60001, NaN]) assert.equal(run.controller.setSettings({ playbackRate: 1, pptInterval: interval }), false);
  assert.equal(run.controller.setSettings({ playbackRate: 2, pptInterval: 5000 }), true);
  assert.equal(run.controller.config.playbackRate, 2);
  assert.ok(run.storage.calls.every(key => key.startsWith('ykt_playback_v1_')));
  assert.ok(!run.storage.calls.some(key => key.includes('ai_conf') || key.includes('feature_conf')));
});

test('存储不可用时降级为内存，日志有数量上限且不包含地址参数', () => {
  let warnings = 0;
  const store = createStore({ read() { throw new Error('unavailable'); }, onError() { warnings++; } });
  const run = make(fixture(), { storage: { store }, config: { logLimit: 3 } });
  for (let index = 0; index < 8; index++) run.controller.log('WAIT_PLAYER');
  assert.equal(store.available, false);
  assert.equal(warnings, 1);
  assert.equal(store.get('logs').length, 3);
  assert.deepEqual(Object.keys(store.get('logs')[0]).sort(), ['code', 'level', 'state', 'time']);
});

test('可见性检查拒绝隐藏、透明和不属于当前文档的证据', () => {
  const doc = new Document();
  const element = new Element(doc);
  assert.equal(isVisible(element), true);
  element.style.opacity = '0';
  assert.equal(isVisible(element), false);
  element.style.opacity = '1';
  element.parentElement = new Element(doc);
  element.parentElement.hidden = true;
  assert.equal(isVisible(element), false);
  element.parentElement.hidden = false;
  element.parentElement.style.opacity = '0';
  assert.equal(isVisible(element), false);
});

test('模拟 PPT：确认页码变化；不以翻页次数判定平台完成', async () => {
  const f = fixture();
  f.doc.media = [];
  f.adapter.getSlide = () => ({ index: f.state.slide, total: 3, next: f.slideNext });
  f.slideNext.onClick = () => { f.state.slide++; };
  let run = make(f, { config: { progressTimeout: 10 } });
  await run.controller.start();
  assert.equal(f.slideNext.clicks, 2);
  assert.equal(lastCode(run), 'PROGRESS_TIMEOUT');
  f.state.slide = 1;
  f.slideNext.clicks = 0;
  f.slideNext.onClick = () => { f.state.slide++; if (f.state.slide === 3) f.progress.innerText = '3/3'; };
  run = make(f);
  assert.equal(await run.controller.start(), true);
  assert.equal(f.slideNext.clicks, 2);
});

test('模拟 PPT 翻页失败只点击一次；暂停期间不再翻页', async () => {
  const f = fixture();
  f.doc.media = [];
  f.adapter.getSlide = () => ({ index: 1, total: 3, next: f.slideNext });
  const run = make(f, { config: { switchTimeout: 10 } });
  await run.controller.start();
  assert.equal(lastCode(run), 'SLIDE_TIMEOUT');
  assert.equal(f.slideNext.clicks, 1);
  f.slideNext.clicks = 0;
  const paused = make(f, { onUpdate(event, controller) { if (event.state === 'courseware') controller.pause(); } });
  await paused.controller.start();
  assert.equal(paused.controller.state, 'paused');
  assert.equal(f.slideNext.clicks, 0);
});

test('AI 作业资源默认不执行、不调用播放器', async () => {
  const f = fixture('ai-workspace');
  f.state.href = 'https://www.yuketang.cn/ai-workspace/lms-graph/demo-class/exercise/demo-leaf';
  f.adapter = createAdapter(getRoute(f.state.href), f.doc);
  const run = make(f);
  await run.controller.start();
  assert.equal(lastCode(run), 'RESOURCE_UNVERIFIED');
  assert.equal(f.media.plays, 0);
});

test('PDF 网络权限限定单一课件域，仍无答题、凭据读取、上传和时间跳写', () => {
  const source = fs.readFileSync(require.resolve('../yuketang.js'), 'utf8');
  for (const pattern of [/@connect\s+\*/, /@require\s/, /unsafeWindow/,
    /localStorage/, /sessionStorage/, /document\.cookie/, /html2canvas/, /Tesseract/,
    /fetch\s*\(/, /new\s+XMLHttpRequest/, /sendBeacon/, /currentTime\s*=/,
    /Object\.definePropert/, /preventScreenCheck/, /dismissPopups/, /location\.reload/]) {
    assert.doesNotMatch(source, pattern);
  }
  assert.match(source, /@author\s+风之子/);
  assert.match(source, /@license\s+GPL3/);
  assert.deepEqual([...source.matchAll(/@connect\s+(\S+)/g)].map(m => m[1]), ['qn1-next.xuetangonline.com']);
  assert.equal((source.match(/@grant\s/g) || []).length, 5);
  assert.equal((source.match(/@resource\s/g) || []).length, 2);
  assert.match(source, /anonymous: true, redirect: 'error'/);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|DELETE)['"]/);
});
