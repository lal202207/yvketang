'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('会话队列排除作业、讨论及自测，并保留未读课件', async () => {
  const { chooseResource } = await import('../tools/course-session.mjs');
  const items = [{ type: '作业', title: '作业', done: false }, { type: '自测', title: '自测', done: false },
    { type: '讨论', title: '讨论', done: false }, { type: '视频', title: '视频一', done: true },
    { type: '图文', title: '课件一', done: false }];
  assert.equal(chooseResource(items, 2).title, '课件一');
  items[4].done = true;
  assert.equal(chooseResource(items, 2), null);
});

test('目录数量不符或存在同类型同名资源时禁止继续', async () => {
  const { chooseResource } = await import('../tools/course-session.mjs');
  assert.throws(() => chooseResource([]), /数量/);
  assert.throws(() => chooseResource([{ type: '视频', title: '一', done: true }], 2), /数量/);
  assert.throws(() => chooseResource([{ type: '视频', title: '一' }, { type: '视频', title: '一' }], 2), /歧义/);
});

test('同名的视频与图文按资源类型区分', async () => {
  const { chooseResource } = await import('../tools/course-session.mjs');
  const items = [{ type: '视频', title: '同一主题', done: true }, { type: '图文', title: '同一主题', done: false }];
  assert.equal(chooseResource(items, 2).type, '图文');
});

test('倍速菜单异步显示时分两次操作，不提前点击隐藏选项', async () => {
  const { CourseSession } = await import('../tools/course-session.mjs');
  const page = { route: { key: 'lesson', type: 'video', leafId: 'test' },
    visibility: 'visible', dialogs: 0, collapsed: 0,
    items: [{ type: '视频', title: '视频', done: false, active: true }],
    video: { readyState: 4, currentTime: 10, duration: 100, paused: false, ended: false, rate: 1 },
    speeds: [1, 2], speedMenuOpen: false };
  const clicks = [];
  const tab = { playwright: { locator(selector) {
    return {
      async click() { assert.match(selector, /xt-speedbutton/); clicks.push('menu'); },
      getByText(text) { return { async click() {
        assert.equal(page.speedMenuOpen, true);
        clicks.push(text);
        page.video.rate = 2;
      } }; }
    };
  } } };
  const session = new CourseSession(tab, { expectedCount: 1 });
  session.snapshot = async () => structuredClone(page);
  assert.equal((await session.step()).state, 'speed_menu');
  assert.deepEqual(clicks, ['menu']);
  page.speedMenuOpen = true;
  assert.equal((await session.step()).state, 'speed_selected');
  assert.equal((await session.step()).rate, 2);
  assert.deepEqual(clicks, ['menu', '2.00X']);
});
