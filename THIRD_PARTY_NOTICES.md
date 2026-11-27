# 第三方组件

本地脚本保留原作者风之子及GPL3。local.4使用Mozilla PDF.js（pdfjs-dist 6.5.438），由Tampermonkey按脚本元数据下载两个固定版本资源，SHA-256校验失败时不得运行。

- 上游：https://github.com/mozilla/pdf.js
- 发行包：https://www.npmjs.com/package/pdfjs-dist/v/6.5.438
- PDF.js采用Apache License 2.0；完整许可见[licenses/pdfjs-Apache-2.0.txt](licenses/pdfjs-Apache-2.0.txt)。保留发行文件中的版权/许可标头，未修改库代码。
- pdf.mjs SHA-256：`cbabeebf4df66f3fe736f2fa2792d332e019a878b0aa88d5e2be17d439079de4`
- pdf.worker.mjs SHA-256：`43710009ea26bfbcb615524946e46e3aaf8ad927514f5e465e8ff6d18044ffe9`

第三方库仅用于本机解析及渲染PDF；课程文件不会发送给PDF.js开发者、AI服务或其他处理服务。课件仍由其原始站点按用户正常访问权限提供。
