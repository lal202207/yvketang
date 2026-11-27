'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML, Event: LinkeDOMEvent } = require('linkedom');
const { officePptSource, officeFrameContext, officeSlide, pressOfficeButton, installOfficeParent,
  requestOffice, browseOfficePpt } = require('../yuketang.js');
const { testCourse } = require('./fixtures.cjs');
const source = 'https://view.officeapps.live.com/op/embed.aspx?src=' +
  encodeURIComponent('https://qn1-next.xuetangonline.com' + testCourse.officePath);
function framePage() {
  const { document, HTMLElement } = parseHTML(`<html><body><div class="main-text-attachment"><iframe src="${source}"></iframe></div></body></html>`, {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  });
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: 500, height: 300 });
  return { document, iframe: document.querySelector('iframe') };
}
test('Office适配限定已取证PPT及PowerPoint嵌套页面，不接受任意Office文档', () => {
  assert.equal(officePptSource(source), false);
  assert.equal(officePptSource(source, testCourse), true);
  assert.equal(officePptSource(source.replace('demo-slides', 'other'), testCourse), false);
  assert.equal(officePptSource(source.replace('view.officeapps.live.com', 'evil.example'), testCourse), false);
  assert.equal(officeFrameContext('https://kr3-powerpoint.officeapps.live.com/p/PowerPointFrame.aspx',
    'https://view.officeapps.live.com/'), true);
  assert.equal(officeFrameContext('https://evil.example/p/PowerPointFrame.aspx',
    'https://view.officeapps.live.com/'), false);
  assert.equal(officeFrameContext('https://kr3-powerpoint.officeapps.live.com/p/PowerPointFrame.aspx',
    'https://other.example/'), false);
});
test('Office页码来自真实结构的可见画面和状态栏；内嵌媒体单独标识', () => {
  const f = framePage();
  f.document.body.innerHTML = '<span id="SlideLabel-Medium14">第 1 张幻灯片，共 11 张</span><canvas id="scc"></canvas>';
  assert.deepEqual(officeSlide(f.document), { index: 1, total: 11, hasMedia: false });
  f.document.body.appendChild(f.document.createElement('video'));
  assert.equal(officeSlide(f.document).hasMedia, true);
  f.document.getElementById('SlideLabel-Medium14').textContent = '第 0 张幻灯片，共 11 张';
  assert.throws(() => officeSlide(f.document), { code: 'SLIDE_INVALID' });
});
test('Office 翻页按钮需要一次范围内的左键按下及松开', () => {
  const f = framePage();
  const button = f.document.createElement('a');
  f.document.body.appendChild(button);
  f.document.defaultView.MouseEvent = class extends LinkeDOMEvent {
    constructor(type, fields) {
      super(type, fields);
      for (const k of ['button', 'buttons', 'clientX', 'clientY']) this[k] = fields[k];
    }
  };
  button.getBoundingClientRect = () => ({ left: 100, top: 50, width: 20, height: 10 });
  let pressed = false, turned = 0;
  button.addEventListener('mousedown', event => {
    pressed = event.button === 0 && event.buttons === 1 && event.clientX === 110 && event.clientY === 55;
  });
  button.addEventListener('mouseup', event => {
    if (pressed && event.button === 0 && event.buttons === 0 && event.clientX === 110 && event.clientY === 55) turned++;
    pressed = false;
  });
  button.click();
  assert.equal(turned, 0);
  pressOfficeButton(button);
  assert.equal(turned, 1);
});
test('跨域握手必须属于当前课堂当前PPT的直接嵌套窗口', () => {
  const f = framePage();
  const parent = {};
  Object.defineProperty(f.iframe, 'contentWindow', { value: parent });
  const win = new EventTarget();
  win.location = { href: 'https://www.yuketang.cn/ai-workspace/lms-graph/demo-class/graph/demo-reading' };
  const replies = [];
  const child = { parent, postMessage: (...args) => replies.push(args) };
  installOfficeParent(win, f.document, testCourse);
  const send = (origin, sender = child) => {
    const event = new Event('message');
    Object.assign(event, { origin, source: sender, data: { channel: 'ykt-office-ppt-v1', command: 'HELLO', token: 'test' } });
    win.dispatchEvent(event);
  };
  send('https://evil.example');
  send('https://kr3-powerpoint.officeapps.live.com', { ...child, parent: {} });
  assert.equal(replies.length, 0);
  send('https://kr3-powerpoint.officeapps.live.com');
  assert.equal(replies.length, 1);
  assert.equal(replies[0][1], 'https://kr3-powerpoint.officeapps.live.com');
  assert.equal(replies[0][0].command, 'ACK');
});
test('Office请求只接收匹配来源、窗口、随机通道和请求ID的回复，取消后清理等待', async () => {
  const win = new EventTarget();
  win.crypto = { randomUUID: () => 'request-1' };
  let sent;
  const peer = { origin: 'https://kr3-powerpoint.officeapps.live.com', token: 'channel-1',
    source: { postMessage: (data, origin) => { sent = { data, origin }; } } };
  const abort = new AbortController();
  const pending = requestOffice(peer, 'STATE', undefined, abort.signal, 100, win);
  assert.equal(sent.origin, peer.origin);
  const reply = origin => {
    const e = new Event('message');
    Object.assign(e, { origin, source: peer.source, data: { ...sent.data, state: { index: 1, total: 11 } } });
    win.dispatchEvent(e);
  };
  reply('https://evil.example');
  reply(peer.origin);
  assert.deepEqual(await pending, { index: 1, total: 11 });
  const cancelled = requestOffice(peer, 'NEXT', 1, abort.signal, 100, win);
  abort.abort(new Error('paused'));
  await assert.rejects(cancelled, /paused/);
});
function readerOptions(f, extra = {}) {
  const state = { index: 2, total: 3, hasMedia: false, commands: [] };
  const options = { signal: new AbortController().signal,
    course: testCourse,
    config: { pollInterval: 1, playerTimeout: 30, switchTimeout: 6, pptInterval: 1 },
    guard() {}, getPeer: () => ({ iframe: f.iframe }), onPage() {},
    request: async (_peer, command, index) => {
      state.commands.push(command);
      if (command !== 'STATE') {
        assert.equal(index, state.index);
        state.index += command === 'NEXT' ? 1 : -1;
      }
      return { index: state.index, total: state.total, hasMedia: state.hasMedia };
    }, ...extra };
  return { state, options };
}
test('原生PPT先回首张，再按实际页数逐页浏览，末页不多点击', async () => {
  const f = framePage();
  const pages = [];
  const { state, options } = readerOptions(f, { onPage: page => pages.push(page.index) });
  await browseOfficePpt(f.iframe, options);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(state.commands, ['STATE', 'PREV', 'NEXT', 'NEXT']);
});
test('Office 同页过渡只补按一次，仍须确认下一张才计入浏览', async () => {
  const f = framePage();
  const pages = [];
  const { state, options } = readerOptions(f, { onPage: page => pages.push(page.index) });
  const request = options.request;
  let consumed = false;
  options.request = async (...args) => {
    if (args[1] === 'NEXT' && !consumed) {
      consumed = true;
      state.commands.push('NEXT');
      return { index: state.index, total: state.total, hasMedia: false };
    }
    return request(...args);
  };
  await browseOfficePpt(f.iframe, options);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(state.commands.filter(command => command !== 'STATE'), ['PREV', 'NEXT', 'NEXT', 'NEXT']);
});
test('原生PPT暂停不继续翻页；两次均不翻页则停止；页数变化及媒体不误报完成', async () => {
  const f = framePage();
  const abort = new AbortController();
  const paused = readerOptions(f, { signal: abort.signal, onPage: () => abort.abort(new Error('paused')) });
  await assert.rejects(browseOfficePpt(f.iframe, paused.options), /paused/);
  assert.equal(paused.state.commands.filter(x => x === 'NEXT').length, 0);
  const stuck = readerOptions(f);
  stuck.state.index = 1;
  stuck.options.request = async (_p, command) => {
    stuck.state.commands.push(command); return { index: 1, total: 3, hasMedia: false };
  };
  await assert.rejects(browseOfficePpt(f.iframe, stuck.options), { code: 'SLIDE_TIMEOUT' });
  assert.equal(stuck.state.commands.filter(x => x === 'NEXT').length, 2);
  const media = readerOptions(f);
  media.state.hasMedia = true;
  await assert.rejects(browseOfficePpt(f.iframe, media.options), { code: 'RESOURCE_UNVERIFIED' });
  const changed = readerOptions(f);
  const request = changed.options.request;
  changed.options.request = async (...args) => {
    const s = await request(...args); if (args[1] === 'NEXT') s.total++; return s;
  };
  await assert.rejects(browseOfficePpt(f.iframe, changed.options), { code: 'SLIDE_INVALID' });
});
