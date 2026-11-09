# 布丁工具箱（pudi-tools）

一个基于 **Tauri 2 + 原生 HTML / CSS / JavaScript** 的 Windows 桌面工具集合，把贴图处理、图片 / 音视频转换、PDF 导出和几个日常小工具收进同一个窗口。前端不依赖框架，文件处理基本都在本机完成，不上传素材；只有「视频下载」与「yt-dlp 自检更新」需要联网。

版本号由 `scripts/bump-version.mjs` 统一维护（每次构建自动 +1），以 `package.json` 为准。自绘标题栏、深色 / 浅色主题、窗口置顶、页签显示与排序均可自定义，偏好保存在 `localStorage`。

## 功能一览

共 17 个页签，其中 **批量重命名** 目前是占位页（界面保留，功能未接），其余 16 个可用。

### 贴图与图像

| 工具 | 说明 |
| --- | --- |
| 序列图分割 | 按行列切分 sprite sheet，带逐帧预览 / 播放 / 帧率设置，导出 PNG、TGA |
| 序列图合并 | 多帧合成为图集，支持每帧旋转 90°、显示边界、输出尺寸与格式（PNG / TGA / JPG） |
| 图片格式转换 | 单张 / 批量；可导入 PNG、JPEG、BMP、GIF、WEBP、TGA、TIFF、HDR / RGBE、DDS、OpenEXR、PNM 系列、HEIC / HEIF，导出 PNG、JPEG、WEBP、TGA |
| 贴图转法线 | 灰度高度转法线，可选亮度 / 平均 / 单通道、DirectX 或 OpenGL 绿通道约定、模糊半径、强度、高度反转 |
| 无缝贴图 | 多尺度边缘融合，双向 / 单向融合、平铺预览（1×1 ~ 3×3）、接缝指标、保留透明通道 |
| Flowmap 绘制 | 笔刷绘制 RG 流向，支持四方连续、撤销重做、底图导入，WebGL 实时流动预览，导出 PNG / TGA |
| 制作 GIF | 图片序列或视频片段转 GIF，可选时间区间、画面裁剪、帧率、缩放、循环次数、颜色数与调色板质量 |
| GIF 动画预览 | 逐帧查看与播放，调速、抽帧、裁剪、导出整段 GIF 或当前帧 PNG |

### 音视频与文档

| 工具 | 说明 |
| --- | --- |
| 视频格式转换 | 调用内置 FFmpeg，单张 / 批量；容器（MP4 / WebM / MKV / AVI / MOV / FLV / TS）、H.264 / H.265 / VP9 / AV1、CRF、编码预设、分辨率、帧率、码率、画面裁剪 |
| 音频格式转换 | 单张 / 批量，也能从视频提取音轨；MP3 / WAV / FLAC / AAC / M4A / OGG / Opus，可调比特率、采样率、声道与截取区间 |
| 视频下载 | 内置 yt-dlp 解析上千个站点，列出可用格式 / 分辨率 / 编码，支持合集批量、进度显示与 yt-dlp 自检更新 |
| PDF 转图片 | 基于内置 pdf.js 渲染，PNG / JPEG、96 ~ 600 DPI、全部页或当前页，默认导出到 PDF 同级的同名文件夹 |

### 3D 模型

| 工具 | 说明 |
| --- | --- |
| **模型预览** | 本地 WebGL 视口，支持 GLB / glTF、OBJ + MTL、FBX、STL、PLY、DAE、3MF、3DS、VRML、VOX、AMF、PCD / XYZ、USD / USDA / USDC / USDZ、KMZ、LWO、MD2、GCode、VTK；9 个检查通道（PBR、Albedo、法线、粗糙度、金属度、自发光、不透明度、Unlit、线框）、材质与面数统计、动画片段选择与播放、标准视角、坐标轴和包围盒、画质调节、自动旋转、截图导出。分离式模型的贴图 / `.bin` / `.mtl` 会自动从同目录补齐 |

> 基于随仓库 vendor 的 three.js 0.180.0（MIT），离线可用；`.blend` / `.max` / `.ma` / `.mb` 等内部格式请先导出 glTF。Albedo 项目专有的 NIF 读取器与自研 USDC 解码器不在其中。

### 桌面小工具

| 工具 | 说明 |
| --- | --- |
| 翻页时钟 | 扁平 / 立体 / 数字时钟三种风格，12 / 24 小时制，缩放与全屏 |
| 电脑配置 | 基础档读注册表与系统 API（毫秒级），详细档额外查 WMI（内存条、磁盘、显卡驱动、主板 / BIOS、网卡等），支持一键复制 |
| 自动关机 | 倒计时或定点时刻执行关机 / 重启，最后 60 秒强提醒、关窗拦截、到点 15 秒缓冲可中止 |
| 批量重命名 | ⚠️ 占位页，功能开发中；计划支持前缀 + 序号、查找替换、按日期 / 路径改名与「原名 → 新名」预览 |

> 标题栏的「工具列表」按钮可以勾选要显示的页签，并支持拖动自定义顺序、按名称、按最近使用排序。

## 快速开始

### 环境要求

- Windows 10 / 11（打包目标为 NSIS，系统信息、电源操作走 Windows API）
- Node.js **20.11+**（脚本用到 `import.meta.dirname`；已在 Node 22 验证）
- Rust 稳定版 **1.85+**（`Cargo.toml` 使用 edition 2024）与 MSVC 生成工具
- WebView2 Runtime（Windows 11 一般已内置）
- PowerShell 与联网环境：首次构建要下载 FFmpeg 和 yt-dlp

### 安装与运行

```bash
npm install
npm run dev          # tauri dev，调试运行桌面窗口
```

只想看前端界面、不启动 Tauri，可以用内置的零依赖静态服务器：

```bash
node serve.js              # 默认 http://localhost:8080
node serve.js 8123         # 指定端口
```

浏览器预览模式下，`platform.js` 会自动退回 `<input type="file">`、Blob URL 和浏览器下载。**依赖 Rust 后端的页（视频 / 音频转换、视频下载、电脑配置、自动关机）在此模式下不可用**，导出也会退化为浏览器下载而非写入原目录。

## 构建与发版

```bash
npm run build        # 正式构建，产出 NSIS 安装包
```

`npm run build` = `node scripts/prepare-build.mjs && tauri build`，**每次执行会自动把修订号 +1**，并同步到 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 五处，同时准备好外部依赖。不想改版本号时请留意这一点。

版本号也可以单独管理：

```bash
npm run bump                              # 0.1.26 -> 0.1.27
npm run version:minor                     # 0.1.26 -> 0.2.0
npm run version:major                     # 0.1.26 -> 1.0.0
node scripts/bump-version.mjs --set 1.2.3
node scripts/bump-version.mjs --dry-run   # 只看结果，不落盘
```

需要免安装的绿色版，直接双击根目录的 `build-portable.cmd`：它会下载 FFmpeg、编译 release（不打安装包）、把 `ffmpeg.exe` 复制到 exe 同级目录并清理 `.pdb`。产物在 `src-tauri/target/release/`，`布丁工具箱.exe` 与 `ffmpeg.exe` 需放在同一目录。

> 便携版脚本只复制了 `ffmpeg.exe`，没有复制 `yt-dlp.exe`；如需使用「视频下载」，请手动把 `src-tauri/resources/yt-dlp.exe` 也放到 exe 同级目录。

### 外部依赖

`ffmpeg.exe`、`yt-dlp.exe` 体积较大，**不入库**（见 `.gitignore`），由 `scripts/download-deps.ps1` 在构建前自动准备：

- FFmpeg：gyan.dev 的 `ffmpeg-release-essentials.zip`，解压取 `ffmpeg.exe`
- yt-dlp：GitHub Releases 的 `yt-dlp.exe`

下载到 `src-tauri/resources/`，已存在且大小正常时会跳过。视频元数据通过 `ffmpeg -i` 解析，**不需要额外的 ffprobe.exe**。PDF 渲染用的 pdf.js 已随仓库放在 `src/vendor/pdfjs/`。

## 目录结构

```
src/                  前端：index.html、styles.css、js/（各页逻辑与解码器）、vendor/pdfjs + vendor/three、assets/
src-tauri/            Rust 后端：lib.rs（文件 / FFmpeg / yt-dlp 命令）、system.rs（系统信息、电源）、icons/
scripts/              版本号递增、外部依赖下载、构建前准备
assets/               应用图标与参考素材
test/                 各格式解码与算法的验证脚本、样本文件
serve.js              纯前端预览用的静态服务器
build-portable.cmd    便携版打包脚本
```

## 实现要点

- 无前端框架：ES Modules + Canvas / WebGL / Web Worker；TGA、TIFF、DDS、EXR、HDR、PNM、GIF 等格式由 `src/js/` 下的自写解码器处理，HEIC / HEIF 交给 Rust 的 `zune-heic`。
- `src/js/platform.js` 是前后端的唯一适配层：Tauri 下走 `invoke` 与 asset 协议，浏览器下走 File / Blob，保存同名冲突、序列帧自动补全等逻辑都收在这里。
- Rust 侧提供文件读写、列表、目录创建、HEIC 解码、FFmpeg 转码、yt-dlp 下载与更新、系统信息与电源操作；大块二进制走原始字节 IPC，避免 base64 开销。
- 「模型预览」用 importmap 把裸模块 `three` / `three/addons/` 映射到 `src/vendor/three/`，无打包器、完全离线；外部贴图通过 `LoadingManager.setURLModifier` 指向同目录资源生成的 blob URL，并只读取模型中实际引用到的文件名。
- 模型用外层 pivot 居中缩放（不改动 FBX 等格式自带的单位与旋转），地面网格按模型尺寸自适应；贴图缺失 / 加载失败时剔除空贴图并回退到材质本色，避免模型整只变黑；老式 Phong / Lambert 材质在金属度 / 粗糙度通道显示占位灰并在状态栏提示。
- 页签显隐 / 排序、主题、置顶等偏好全部存在 `localStorage`，不写配置文件。

## 已知限制

- 面向 Windows 开发；其他平台没有做完整适配与打包验证。
- 高位深图（HDR / EXR 等）导出 PNG / JPEG / WEBP / TGA 时会量化为 8 位。
- 「制作 GIF」读取视频依赖 WebView2 的 Media Foundation 解码能力，H.264 / VP9 通常可用，MKV / AVI / WMV 多数不行。
- 自动关机的计时只在软件内维持，程序退出后计划即失效，到点不会关机。
- 视频下载能否成功取决于目标站点与网络环境；yt-dlp 可在应用内检查并更新。
- 3D 预览只做检查与展示，不含编辑、重拓扑与烘焙；CAD / BIM 格式（STEP / IGES / IFC）暂未接入。
- `批量重命名` 尚未实现，界面按钮处于禁用状态。
