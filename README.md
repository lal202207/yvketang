# 雨课堂辅助播放脚本

`yuketang.js` 是一个在 Tampermonkey 中运行的用户脚本，支持播放当前页面的音视频，以及手动暂停、停止和恢复。版本为 `3.0.7-local.8`。

默认配置尝试播放当前页唯一可用的媒体。本地配置经核验的课堂后，脚本可使用网页的实际状态核对进度，按目录切换视频或图文，并逐页浏览支持的 PDF 和 Office PPT。恢复任务由用户发起，遇到网页提示时由用户处理。

## 安装与测试

在 Tampermonkey 新建脚本，粘贴 [`yuketang.js`](yuketang.js) 的完整内容并保存。从具体课程资源页打开脚本面板。安装步骤、权限和课堂配置见 [安装说明](INSTALL.md)。

开发和测试使用 Node.js 22 或更高版本。

```bash
npm ci
npm run check
npm test
```

## 本次更新

`3.0.7-local.8` 将课堂标识、资源数量和 Office 课件路径改为本地配置。测试使用合成数据覆盖进度核对和课件浏览。

## 作者与许可

本项目基于风之子维护的雨课堂脚本，保留上游贡献者署名。上游项目与更新记录见 [Niuwh/yuketang-jiaoben](https://github.com/Niuwh/yuketang-jiaoben)。

上游贡献者包括 duck123ducker、insorker、PRO-2684、pioneerRick、语冰、ANGJustinl、tfia 和 xinyangcui。

脚本采用 GPL v3。PDF.js 的版本、校验值和许可见 [第三方组件](THIRD_PARTY_NOTICES.md)。完整项目许可见 [LICENSE](LICENSE)。
