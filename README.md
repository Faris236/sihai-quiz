# 四海刷题册（PWA）

考公判断推理 / 课程试卷 离线刷题工具。

## 使用

访问 GitHub Pages 部署地址 → Safari → 分享 → **添加到主屏幕** → 桌面图标点开即用，完全离线。

## 结构

- `index.html` — 入口与全部 UI / 逻辑
- `manifest.webmanifest` — PWA 清单
- `sw.js` — Service Worker，缓存静态资源 + 题库
- `data/index.json` — 题册索引
- `data/<paperId>.json` — 单套题册数据
- `icons/` — 图标

## 新增题册

1. 把题册 JSON 放进 `data/`
2. 在 `data/index.json` 的 `papers` 数组里加一条
3. `git push`
4. 手机上下次联网打开会自动同步

## 数据隐私

做题历史、正确率、用时全部存在浏览器本地 `localStorage`，**不上传**。可在"数据"页导出 JSON 备份。
