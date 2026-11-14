import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Vite 总会把入口 index.html 写进 outDir；主程序用的是自己的 src/index.html，
// 这份是多余的，构建后直接删掉，避免目录里出现两个 index.html 造成困惑。
const generatedHtml = fileURLToPath(new URL('../src/diskmon/index.html', import.meta.url));
const dropGeneratedHtml: Plugin = {
  name: 'drop-diskmon-generated-html',
  closeBundle() { fs.rmSync(generatedHtml, { force: true }); },
};

// 现有主程序是无打包器的原生前端，React 子应用单独构建成固定文件名的产物：
//   src/diskmon/app.js     单个 ESM bundle（React 已打进去，无需 importmap）
//   src/diskmon/style.css  组件样式（作用域化到 #page-diskmon）
// 主 index.html 直接引用这两个文件，Tauri frontendDist="../src" 与 serve.js 均可用。
export default defineConfig({
  plugins: [react(), dropGeneratedHtml],
  base: './',
  build: {
    outDir: '../src/diskmon',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: (info) =>
          info.name && info.name.endsWith('.css') ? 'style.css' : '[name][extname]',
      },
    },
  },
});
