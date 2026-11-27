'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { pdfUrl, downloadPdf, browsePdf, PlaybackController, createStore } = require('../yuketang.js');
const { fixture, memoryStore, locks } = require('./fixtures.cjs');

const url = 'https://qn1-next.xuetangonline.com/synthetic.pdf#toolbar=0';
test('PDF 地址只允许已取证 HTTPS 课件域及 PDF；不扩大到账号页或任意下载源', () => {
  assert.equal(pdfUrl(url), url.split('#')[0]);
  for (const invalid of [null, 'not-a-url', 'https://example.com/a.pdf', 'http://qn1-next.xuetangonline.com/a.pdf',
    'https://qn1-next.xuetangonline.com/a.js', 'https://user:secret@qn1-next.xuetangonline.com/a.pdf']) {
    assert.throws(() => pdfUrl(invalid), { code: 'PDF_ERROR' });
  }
});
test('PDF 使用匿名 GET，不带凭据、上传内容或允许重定向；取消中止请求', async () => {
  const abort = new AbortController();
  let details, aborted = false;
  const request = value => { details = value; return { abort() { aborted = true; } }; };
  const pending = downloadPdf(url, abort.signal, 1000, request);
  assert.equal(details.method, 'GET');
  assert.equal(details.anonymous, true);
  assert.equal(details.redirect, 'error');
  assert.equal(details.data, undefined);
  assert.equal(details.headers, undefined);
  abort.abort(new Error('test cancellation'));
  await assert.rejects(pending, /test cancellation/);
  assert.equal(aborted, true);
});
test('PDF HTTP 失败及实际超时停止；Chrome fetch 模式下仍取消请求', async () => {
  await assert.rejects(downloadPdf(url, new AbortController().signal, 50, details => {
    details.onload({ status: 403, response: new ArrayBuffer(2) }); return {};
  }), { code: 'PDF_ERROR' });
  let aborted = false;
  await assert.rejects(downloadPdf(url, new AbortController().signal, 3, () => ({
    abort() { aborted = true; }
  })), { code: 'PDF_TIMEOUT' });
  assert.equal(aborted, true);
});
function pdfFixture({ failPage = 0, pendingPage = 0 } = {}) {
  const { document } = parseHTML(`<html><body><div><iframe src="${url}"></iframe></div></body></html>`);
  const iframe = document.querySelector('iframe');
  const state = { destroyed: false, cancelled: false, rendered: [], pages: [], loadingOptions: null };
  const pdf = { numPages: 3, async getPage(index) { return {
    getViewport: ({ scale }) => ({ width: 800 * scale, height: 600 * scale }), cleanup() {},
    render() { return { cancel() { state.cancelled = true; }, promise: pendingPage === index
      ? new Promise(() => {}) : failPage === index ? Promise.reject(Error('bad PDF'))
        : Promise.resolve().then(() => { state.rendered.push(index); }) }; }
  }; } };
  const options = { signal: new AbortController().signal, config: { playerTimeout: 30, pptInterval: 1 },
    guard() {}, onPage(page) { state.pages.push(page.index); },
    download: async () => new ArrayBuffer(1), loadLibrary: async () => ({
      getDocument(parameters) { state.loadingOptions = parameters; return {
        promise: Promise.resolve(pdf), async destroy() { state.destroyed = true; }
      }; }
    }) };
  return { iframe, document, state, options };
}
test('PDF 依据真实页数逐页等待渲染，末页结束并释放文档', async () => {
  const f = pdfFixture();
  await browsePdf(f.iframe, f.options);
  assert.deepEqual(f.state.rendered, [1, 2, 3]);
  assert.deepEqual(f.state.pages, [1, 2, 3]);
  assert.equal(f.document.querySelector('[role="status"]').textContent, 'PDF 第 3 / 3 页已渲染');
  assert.equal(f.state.loadingOptions.isEvalSupported, false);
  assert.equal(f.state.destroyed, true);
});
test('PDF 渲染失败不记页码、不切下一页；超时取消当前渲染', async () => {
  const failed = pdfFixture({ failPage: 2 });
  await assert.rejects(browsePdf(failed.iframe, failed.options), { code: 'PDF_ERROR' });
  assert.deepEqual(failed.state.pages, [1]);
  assert.equal(failed.state.cancelled, true);
  assert.equal(failed.state.destroyed, true);
  const timeout = pdfFixture({ pendingPage: 1 });
  await assert.rejects(browsePdf(timeout.iframe, timeout.options), { code: 'PDF_TIMEOUT' });
  assert.deepEqual(timeout.state.pages, []);
  assert.equal(timeout.state.cancelled, true);
});
test('PDF 页间暂停后不再渲染，人工重新开始重新核验；资源被换走立即停止', async () => {
  const f = pdfFixture();
  const abort = new AbortController();
  f.options.signal = abort.signal;
  f.options.onPage = page => { f.state.pages.push(page.index); abort.abort(new Error('paused')); };
  await assert.rejects(browsePdf(f.iframe, f.options), /paused/);
  assert.deepEqual(f.state.pages, [1]);
  assert.equal(f.state.destroyed, true);
  const replaced = pdfFixture();
  replaced.options.onPage = () => replaced.iframe.remove();
  await assert.rejects(browsePdf(replaced.iframe, replaced.options), { code: 'MEDIA_REPLACED' });
  assert.deepEqual(replaced.state.rendered, [1]);
});
test('课件复看不能从视频/作业页误启动', async () => {
  const f = fixture('ai-workspace');
  const controller = new PlaybackController({ doc: f.doc, href: () => f.state.href,
    store: memoryStore(createStore).store, locks: locks() });
  assert.equal(await controller.start({ readingsOnly: true }), false);
  assert.equal(controller.logs.at(-1).code, 'READING_START');
  assert.equal(f.media.plays, 0);
});
