// 当前 Chrome 会话的协作控制器；只通过 Browser 的正常网页操作，不访问扩展内部页面。
import { createRequire } from 'node:module';
const userscript = createRequire(import.meta.url)('../yuketang.js');
const { getRoute, VerifiedCourse } = userscript;
const supported = new Set(['视频', '图文']);

export function chooseResource(items, expectedCount = VerifiedCourse.resourceCount) {
  const resources = items.filter(item => supported.has(item.type));
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || resources.length !== expectedCount) {
    throw new Error('课程资源数量与已核验清单不符');
  }
  const keys = resources.map(item => `${item.type}:${item.title}`);
  if (new Set(keys).size !== keys.length) throw new Error('资源标题存在歧义，需要重新核验');
  return resources.find(item => !item.done) || null;
}

export class CourseSession {
  constructor(tab, { playbackRate = 2, classroomId = VerifiedCourse.classroomId,
    expectedCount = VerifiedCourse.resourceCount, onConfirmed = async () => {} } = {}) {
    this.tab = tab;
    this.playbackRate = playbackRate;
    this.classroomId = classroomId;
    this.expectedCount = expectedCount;
    this.onConfirmed = onConfirmed;
    this.confirmed = new Set();
    this.steps = 0;
    this.activeKey = null;
    this.stopped = false;
  }
  async snapshot() {
    const route = getRoute(await this.tab.url());
    if (!this.classroomId || route?.family !== 'ai-workspace' || route.classroomId !== this.classroomId
      || !['video', 'graph'].includes(route.type)) throw new Error('已离开本课程支持的资源页面');
    const page = await this.tab.playwright.evaluate(() => {
      const visible = node => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
      const root = document.querySelector('.learning-space-student-knowledge-nav .nav-list');
      const nodes = [...(root?.querySelectorAll('.nav-item-leaf-box .leaf-item') || [])];
      const video = document.querySelector('.content-detail .learning-space-video .video-box video');
      const reading = document.querySelector('.content-detail .lms-graph-article');
      return {
        visibility: document.visibilityState,
        dialogs: [...document.querySelectorAll('.content-detail .el-dialog__wrapper, .content-detail .el-message-box__wrapper')].filter(visible).length,
        collapsed: root?.querySelectorAll('.expand-icon:not(.is-expanded)').length || 0,
        items: nodes.map(node => ({ title: node.querySelector('.leaf-item-title')?.innerText?.trim() || '',
          type: node.querySelector('.leaf-item-tag')?.innerText?.trim() || '',
          done: !!visible(node.querySelector('.leaf-item-status > i.icon-yuanquangou')),
          active: node.classList.contains('is-active') })),
        video: visible(video) ? { currentTime: video.currentTime, duration: video.duration, paused: video.paused,
          ended: video.ended, rate: video.playbackRate, readyState: video.readyState, error: video.error?.code || null } : null,
        speeds: [...document.querySelectorAll('.video-box xt-speedlist li[data-speed]')].map(node => Number(node.getAttribute('data-speed'))),
        speedMenuOpen: !!visible(document.querySelector('.video-box xt-speedlist')),
        reading: reading ? {
          title: reading.querySelector('.learning-space-control-unit .unit-title')?.innerText?.trim() || '',
          status: reading.querySelector('.learning-space-control-unit .control-right .f12.color-9b')?.innerText?.trim() || '',
          visible: !!visible(reading.querySelector('.main-text-attachment'))
        } : null,
        progress: document.querySelector('.nav-progress')?.innerText || ''
      };
    });
    return { ...page, route };
  }
  async step() {
    if (this.stopped) return { state: 'stopped' };
    if (++this.steps > 5000) return this.stop('达到本轮检查上限');
    const page = await this.snapshot();
    if (page.visibility !== 'visible') return this.stop('页面已隐藏，请返回课程后继续');
    if (page.dialogs) return this.stop('页面出现提示框，需要人工处理');
    if (page.collapsed) return this.stop('导航尚未完整展开，需要重新盘点');
    const next = chooseResource(page.items, this.expectedCount);
    const activeNodes = page.items.filter(item => item.active);
    if (activeNodes.length !== 1 || !supported.has(activeNodes[0].type)) return this.stop('活动资源不明确');
    const active = activeNodes[0];
    const now = Date.now();
    if (page.route.key !== this.activeKey) {
      if (this.target && (active.title !== this.target.title || active.type !== this.target.type)) {
        if (now - this.targetTime > 15000) return this.stop('资源切换未确认成功');
        return { state: 'switching' };
      }
      this.activeKey = page.route.key;
      this.started = now;
      this.lastAdvance = now;
      this.lastTime = -1;
      this.wasPlaying = false;
      this.speedAttempted = false;
      this.speedPhase = null;
      this.playAttempted = false;
      this.target = null;
    }
    if (now - this.started > 4 * 60 * 60 * 1000) return this.stop('单项资源超过时限');
    if (active.type === '视频') {
      const video = page.video;
      if (!video || video.readyState < 2) {
        if (now - this.started > 20000) return this.stop('播放器未就绪');
        return { state: 'loading', title: active.title };
      }
      if (video.error) return this.stop('播放器报告加载错误');
      if (!video.ended) {
        if (video.paused) {
          if (this.wasPlaying || this.playAttempted) return this.stop('网页或用户暂停了播放');
          this.playAttempted = true;
          await this.tab.playwright.locator('.video-box xt-playbutton').click();
          return { state: 'starting', title: active.title };
        }
        this.wasPlaying = true;
        if (video.currentTime > this.lastTime) this.lastAdvance = now;
        this.lastTime = video.currentTime;
        if (now - this.lastAdvance > 60000) return this.stop('播放长时间没有推进');
        if (this.speedPhase === 'menu') {
          this.speedPhase = null;
          if (page.speedMenuOpen) {
            await this.tab.playwright.locator('.video-box xt-speedlist')
              .getByText(`${this.playbackRate.toFixed(2)}X`, { exact: true }).click();
            return { state: 'speed_selected', title: active.title };
          }
        }
        if (!this.speedAttempted && video.rate !== this.playbackRate && page.speeds.includes(this.playbackRate)) {
          this.speedAttempted = true;
          this.speedPhase = 'menu';
          await this.tab.playwright.locator('.video-box xt-speedbutton').click();
          return { state: 'speed_menu', title: active.title };
        }
        return { state: 'playing', title: active.title, currentTime: video.currentTime, duration: video.duration,
          rate: video.rate, confirmed: page.items.filter(item => supported.has(item.type) && item.done).length };
      }
    } else if (!page.reading?.visible || page.reading.title !== active.title || now - this.started < 3000) {
      if (now - this.started > 20000) return this.stop('图文正文未确认加载');
      return { state: 'reading', title: active.title };
    }
    if (!active.done || (active.type === '图文' && page.reading.status !== '已读')) {
      this.waitProgressSince ??= now;
      if (now - this.waitProgressSince > 30000) return this.stop('未取得当前资源的真实完成状态');
      return { state: 'waiting_progress', title: active.title };
    }
    this.waitProgressSince = null;
    if (!this.confirmed.has(this.activeKey)) {
      await this.onConfirmed({ type: page.route.type, title: active.title, leafId: page.route.leafId,
        verifiedAt: new Date().toISOString(), evidence: active.type === '视频'
          ? '视频自然 ended 且当前资源完成图标可见' : '图文页面已读标签及当前资源完成图标；PDF 内部逐页状态未验证' });
      this.confirmed.add(this.activeKey);
    }
    if (!next) return { state: 'completed', confirmed: this.expectedCount, pageProgress: page.progress,
      resources: page.items.filter(item => supported.has(item.type)) };
    const target = this.tab.playwright.locator('.nav-item-leaf-box .leaf-item').filter({
      has: this.tab.playwright.locator('.leaf-item-tag').getByText(next.type, { exact: true })
    }).getByText(next.title, { exact: true });
    if (await target.count() !== 1) return this.stop('下一项资源定位不唯一');
    this.target = next;
    this.targetTime = now;
    await target.click();
    return { state: 'opened', title: next.title, type: next.type,
      confirmed: page.items.filter(item => supported.has(item.type) && item.done).length };
  }
  stop(reason) { this.stopped = true; return { state: 'needs_user', reason }; }
}
