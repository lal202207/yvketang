'use strict';

// 合成 DOM 契约替身，不是雨课堂页面快照，也不模拟浏览器的 CSS 布局或媒体解码。
const paths = {
  'v2/web': '/v2/web/studentLog/demo-class?classroom_id=demo-class',
  'pro/lms': '/pro/lms/demo-class/studycontent?classroom_id=demo-class',
  'ai-workspace': '/ai-workspace/lms-graph/demo-class/video/demo-leaf'
};
const testCourse = {
  classroomId: 'demo-class',
  resourceCount: 7,
  officeLeafId: 'demo-reading',
  officePath: '/demo-slides.ppt'
};
class Element extends EventTarget {
  constructor(doc, tagName = 'BUTTON', text = '') {
    super();
    Object.assign(this, {
      ownerDocument: doc, tagName, innerText: text, isConnected: true, hidden: false,
      disabled: false, parentElement: null, attributes: {}, style: {}, clicks: 0
    });
  }
  getBoundingClientRect() { return { width: this.hidden ? 0 : 100, height: this.hidden ? 0 : 50 }; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  closest() {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.attributes['aria-hidden'] === 'true' || node.attributes.inert !== undefined) return node;
    }
    return null;
  }
  click() { this.clicks++; this.onClick?.(); this.dispatchEvent(new Event('click')); }
}
class Media extends Element {
  constructor(doc, { mode = 'end', tagName = 'VIDEO' } = {}) {
    super(doc, tagName);
    Object.assign(this, {
      mode, currentTime: 0, duration: 10, paused: true, ended: false,
      readyState: 4, error: null, playbackRate: 1, plays: 0, pauses: 0, timer: null
    });
  }
  play() {
    this.plays++;
    if (this.mode === 'reject') return Promise.reject(new Error('fixture sensitive key: do not log'));
    if (this.mode === 'pending') return new Promise(resolve => { this.resolvePlay = () => { this.paused = false; resolve(); }; });
    this.paused = false;
    if (this.mode !== 'stall') {
      let ticks = 0;
      this.timer = setInterval(() => {
        this.currentTime += 1;
        ticks++;
        if (this.mode === 'end' && ticks === 3) {
          this.currentTime = this.duration;
          this.ended = true;
          this.paused = true;
          clearInterval(this.timer);
          this.dispatchEvent(new Event('ended'));
          this.onEnd?.();
        }
      }, 4);
    }
    return Promise.resolve();
  }
  pause() {
    this.pauses++;
    this.paused = true;
    clearInterval(this.timer);
    this.dispatchEvent(new Event('pause'));
  }
}
class Document extends EventTarget {
  constructor() {
    super();
    this.visibilityState = 'visible';
    this.media = [];
    this.defaultView = { getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }) };
  }
  querySelectorAll(selector) {
    if (selector !== 'video, audio') throw new Error('不支持或意外新增的选择器：' + selector);
    return this.media;
  }
}
function memoryStore(createStore) {
  const data = new Map();
  const calls = [];
  const store = createStore({
    read(key, fallback) { calls.push(key); return data.has(key) ? data.get(key) : fallback; },
    write(key, value) { calls.push(key); data.set(key, structuredClone(value)); },
    remove(key) { calls.push(key); data.delete(key); }
  });
  return { store, data, calls };
}
function locks() {
  let busy = false;
  return {
    async request(name, options, callback) {
      if (busy) return callback(null);
      busy = true;
      try { return await callback({ name }); } finally { busy = false; }
    }
  };
}
function fixture(family = 'v2/web', options = {}) {
  const doc = new Document();
  const media = new Media(doc, options);
  doc.media = [media];
  const state = { href: 'https://www.yuketang.cn' + paths[family], lesson: 'lesson-1', total: 1, slide: 1 };
  const progress = new Element(doc, 'SPAN', '0%');
  const next = new Element(doc);
  const slideNext = new Element(doc);
  const adapter = {
    family, verified: true,
    getLessonKey: () => state.lesson,
    getMedia: () => doc.media.filter(node => node.isConnected),
    getCompletion: () => ({ node: progress, lessonKey: state.lesson }),
    getNext: () => ({ verified: true, lessonKey: state.lesson, end: true }),
    getSlide: () => null
  };
  media.onEnd = () => { progress.innerText = '100%'; };
  return { doc, media, state, progress, next, slideNext, adapter };
}
module.exports = { Element, Media, Document, paths, testCourse, memoryStore, locks, fixture };
