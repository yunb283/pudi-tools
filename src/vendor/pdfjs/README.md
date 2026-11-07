# pdf.js（PDF 转图片页用）

- 来源：npm 包 `pdfjs-dist@4.10.38`（Apache-2.0，许可证见同目录 LICENSE）
- 取用文件：
  - `pdf.min.mjs` —— 主库，前端 `src/js/pdf-page.js` 直接 import
  - `pdf.worker.min.mjs` —— 渲染 worker，通过 `GlobalWorkerOptions.workerSrc` 指向这里
- 为什么要入库：应用是离线桌面程序，不能走 CDN；Tauri 打包时 `frontendDist` 就是 `src`，
  这两个文件会跟着一起打包。
- 升级方法：`npm install pdfjs-dist@新版本`，再把 `node_modules/pdfjs-dist/build/` 下的
  `pdf.min.mjs` 和 `pdf.worker.min.mjs` 覆盖过来即可（worker 的文件名在 pdf-page.js 里
  写死了，改名要同步改）。

注意：这两个文件是 `.mjs`，服务器要按 `text/javascript` 发，否则浏览器会以 MIME 不符
拒绝加载 ES 模块。
