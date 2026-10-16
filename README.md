# Download Any · 抖音 / B 站视频下载

支持 Windows、macOS 和 Linux 的本地视频下载工具。界面在本机浏览器中打开，视频直接保存到本机。**同一个输入框自动识别抖音或 B 站**，粘贴网址或整段分享文案后点击「开始下载」，不需要选择平台。

另支持 [Linux 服务器一键部署](LINUX.md)：使用服务器 IP + 端口访问、密码登录。服务器临时处理，最终文件由浏览器保存到访问者设备，临时结果默认 2 小时后清理；无需购买域名。

## Linux 一键安装：填写 IP、端口和密码

在 **Linux 服务器的 SSH 终端**执行下面这一整行。只替换最后的 IP、端口和密码，密码至少 12 个字符，并保留两边的英文单引号：

```bash
curl -fL --connect-timeout 20 --max-time 120 --retry 2 https://raw.githubusercontent.com/yushengsheng/download-any/main/deploy-linux.sh -o /tmp/download-any-deploy.sh && sudo bash /tmp/download-any-deploy.sh 你的服务器公网IP 8686 '你的自定义密码至少12位'
```

例如下面是输入样式（IP 和密码仅作示例，安装前请替换）：

```bash
curl -fL --connect-timeout 20 --max-time 120 --retry 2 https://raw.githubusercontent.com/yushengsheng/download-any/main/deploy-linux.sh -o /tmp/download-any-deploy.sh && sudo bash /tmp/download-any-deploy.sh 203.0.113.10 8686 'MyVideoPass2026!'
```

命令末尾的格式固定为：`公网IP 端口 '自定义密码'`。部署成功后，浏览器打开 `http://你的服务器公网IP:端口`，输入你设置的密码即可，不需要用户名。**不再自动生成随机密码**。云服务器安全组需放行对应 TCP 端口；默认端口为 8686。

支持 Ubuntu 22.04/24.04、Debian 12/13，x64/ARM64。重跑带参数的命令会使用新的 IP、端口和密码；只更新程序并保留设置时，执行 `sudo bash /tmp/download-any-deploy.sh`。自定义目录、密码含引号的输入方式、更新与加密访问见 [Linux 部署说明](LINUX.md)。

## 支持的链接

以下格式会自动识别，无需手工转换：

- 手机分享短链接：`https://v.douyin.com/…/`，或包含该链接的整段分享文案。
- 视频网址：`https://www.douyin.com/video/视频编号`。
- 搜索结果、精选页或个人主页中打开视频后的网址：包含 `modal_id=视频编号` 的链接会自动转换为对应的视频网址。
- B 站视频网址：`https://www.bilibili.com/video/BV…/` 或 `av…`，以及包含它的分享文案。
- B 站短链接：`https://b23.tv/…`。分 P 视频保留 `p=2` 等参数；没有指定时下载第 1 P，不会自动下载整个合集。

从聊天或网页复制时产生的 `https\://`、`www\.bilibili.com`、`\&` 和 `&amp;` 也会自动清理。去除追踪参数，保留视频定位信息。视频编号按字符串处理，BV 编号保留大小写。命令行和本地界面共用识别逻辑。

## 快速开始

需要 **Node.js 20 或更新的 LTS 版本**（包含 npm）：[下载 Node.js](https://nodejs.org/)。

- **Windows**：双击 `双击运行下载.cmd`。
- **macOS**：双击 `双击运行下载.command` 或项目内的 `抖音视频下载.app`。
- **Linux / 终端**：在项目目录执行 `npm start`，或从任意目录执行 `node /项目所在路径/start.js`。

Windows 和 macOS 都通过同一个 `start.js` 启动，随后自动打开默认浏览器中的同一套网页 UI。macOS 的 `.app` 只是启动入口，下载、任务状态和目录处理均与 Windows 共用。

首次启动会自动安装项目依赖，需要联网。解析抖音时优先使用本机 Chrome、Edge 或 Chromium，未找到时才按需安装 Chromium，不额外下载独立的 headless shell。视频工具箱与 B 站下载不需要安装解析浏览器。Linux 如果缺少浏览器系统库，可执行 `npx playwright-core install --with-deps --no-shell chromium`。

启动后会自动打开本地界面，粘贴链接并点击「开始下载」。运行期间保留启动窗口，按 `Ctrl+C` 退出。浏览器没有自动打开时，访问启动窗口显示的 `http://127.0.0.1:端口` 地址即可；端口自动分配，不与其他程序争用。

## 目录可自由移动

项目可以放在任意可写目录，支持中文和空格。启动器通过自身位置找到程序，不依赖当前终端目录、用户名或固定盘符。移动整个项目后重新启动即可，无需改代码。macOS 的 `.app` 应与项目文件一起移动，不要单独复制。

默认自动创建并保存到 **项目目录下的 `downloads/`**，界面可直接打开该文件夹。同名视频会自动添加序号，已有文件不会被覆盖。不要将项目放在只读目录；下载中途不要移动项目。

在界面的「保存位置」点击「更改目录」，可以浏览选择文件夹或直接输入路径，点击「保存目录」后自动记住，下次启动继续使用。点击「恢复默认」再保存即可回到项目内的 `downloads/`。下载过程中不能更改目录，已有视频不会被移动。

目录偏好保存在项目内的 `.download-any.json`，不纳入 Git。项目内部的目录以相对路径记忆，移动整个项目后仍可使用；外部目录记住完整位置。如果上次选择的目录不可用，程序会保留该位置并提示重新选择，不会悄悄改到别处下载。

需要其他保存位置时，可设置 `DOWNLOAD_DIR` 环境变量，或在命令行使用 `--output`。**相对路径统一以项目目录为基准**，绝对路径直接使用；配置相对路径后移动项目仍能正常工作。默认不需要任何路径配置。

## 命令行

```sh
npm run download -- "https://www.douyin.com/video/视频编号"
npm run download -- "https://www.bilibili.com/video/BV1DzYy6FEqy/"
npm run download -- "手机复制的整段分享文案" --output "我的视频"
```

macOS / Linux 也可以运行：

```sh
./download_douyin.sh "https://www.douyin.com/video/视频编号"
```

运行环境检查和测试：

```sh
npm run check
npm test
```

`npm run check` 实际启动浏览器并输出自动检测结果。浏览器安装在非标准位置时，可选用 `BROWSER_PATH` 环境变量指定可执行文件，相对路径也以项目目录为基准。

## B 站下载工具

B 站采用 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 解析和下载，使用 [FFmpeg](https://ffmpeg.org/) 合并画面与音轨；优先选择兼容的 H.264 / AAC MP4，无需转码。合并完成后通过 ffprobe 检查音视频轨道和时长，通过检查才发布最终文件。抖音继续使用现有浏览器解析流程。

优先复用 PATH 中可运行的 `yt-dlp`、`ffmpeg`、`ffprobe`。缺少工具时，在使用对应功能时按需安装到项目的 `.tools/`，不影响其他项目。自动安装版本固定在 `tools-manifest.json`：yt-dlp 2026.08.19，以及 [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) 提供的独立 FFmpeg / ffprobe。安装时校验解压后文件的大小和 SHA-256，后续直接复用，不会自动追随最新版本。工具缓存可随项目一起移动；更换操作系统后会自动选择对应版本。

自动安装覆盖 Windows x64/ARM64、macOS Intel/Apple Silicon、Linux x64/ARM64；Windows ARM64 的 FFmpeg 使用系统 x64 兼容运行能力。其他环境可自行安装工具并加入 PATH。也可分别用 `YTDLP_PATH`、`FFMPEG_PATH`、`FFPROBE_PATH` 指定可执行文件，相对路径以项目目录为准。网络无法连接 GitHub 时可使用这些已安装工具。

yt-dlp 及 FFmpeg 的发行许可和来源见 [THIRD_PARTY.md](THIRD_PARTY.md)。工具安装和下载都有超时、有限重试和大小上限；退出时终止下载进程树，清理未完成的临时目录。B 站下载进程上限为 2 小时，单路流上限 20 GiB。下载记录只保留本次启动的任务。

## 视频工具箱：音画分离

在顶部切换到「视频工具箱」，点击「选择视频」或粘贴本地文件的完整路径，再点击「开始分离」。Windows 与 macOS 使用系统文件选择框；Linux 可直接输入路径。选择的文件直接在本机读取处理，无需上传或复制一份源视频。

每次生成两个独立文件：`原名_画面.扩展名` 和 `原名_音频.扩展名`，共用已记住的保存目录。同名文件自动加序号，原视频保持不变。两个文件均通过轨道、编码和时长检查后才显示成功；失败或取消会清理临时文件，并回滚本次已发布的结果。

FFmpeg 根据文件内容识别格式，不单靠后缀判断。已实际测试 MP4、MOV、MKV、AVI、WebM、FLV、TS、WMV、3GP、MPG 的常见编码组合。实际支持取决于文件中的编码及所用 FFmpeg 构建；损坏、加密或缺少音轨/画面的文件会提示失败。多轨视频默认提取主画面和默认音轨，未设置默认轨时使用第一条。

默认直接复制音视频流，不重新编码。H.264 / H.265 / AV1 等画面导出 MP4，VP8 / VP9 导出 WebM，ProRes 等导出 MOV，其他可兼容编码使用 MKV。AAC / ALAC 音频导出 M4A，MP3、FLAC、Opus、Vorbis 等保留对应格式，常见 PCM 导出 WAV，其他编码使用 MKA 等合适容器。因此结果扩展名可能与原视频不同，播放软件需支持该编码。

工具箱只使用现有 FFmpeg / ffprobe，缺少时复用上面的固定版本安装流程，不会安装 yt-dlp。下载与分离共用一个任务槽，避免同时占用大量资源；可点击「取消任务」，处理进程也有 2 小时超时。没有增加 npm 依赖或构建步骤。

## 开发原则

**稳定第一，轻量第二，小而美服务于前两者。** 项目规则记录在 `AGENTS.md`，后续开发应持续遵循：优化不能降低下载成功率、跨平台兼容性和文件完整性。使用 Node.js 标准库和原生网页界面，唯一运行依赖是固定版本的 `playwright-core`，不需要构建步骤。优先使用已安装的系统浏览器。

页面闲置时每 10 秒检查一次状态，切换到后台后暂停轮询；下载中的状态更新为每秒一次。任务、日志、视频候选和重试均有上限，网络有超时，退出时会取消任务并清理临时文件。已完成的视频尽量使用同目录硬链接发布，避免重复复制大文件；不支持硬链接的磁盘会自动使用兼容方式。

## 项目结构

- `start.js`：跨平台启动、首次安装依赖和浏览器、运行环境检查。
- `runtime.js`：项目位置、保存目录、系统浏览器检测。
- `settings.js`、`folder-picker.js`：保存目录偏好和系统文件/文件夹选择，Windows/macOS 共用设置流程。
- `app.js`、`web/`：共用界面与任务管理；本地模式只监听 `127.0.0.1`，服务器模式须先配置密码。
- `server-auth.js`、`server-config.js`、`server-cache.js`：服务器登录、配置、流式上传及临时缓存。
- `deploy-linux.sh`、`LINUX.md`：Linux 部署、升级与服务器使用说明。
- `video-input.js`、`download.js`：统一链接识别、平台调度和命令行入口。
- `download_douyin_core.js`、`download_bilibili.js`：抖音与 B 站下载实现。
- `media-toolbox.js`：本地音画分离、输出格式匹配和双文件校验。
- `media-file.js`：安全文件名和防覆盖发布，下载与工具箱共用。
- `download-tools.js`、`tools-manifest.json`、`process-runner.js`：按需安装与校验外部工具、受控子进程。
- `双击运行下载.cmd`、`双击运行下载.command`：Windows / macOS 双击入口。
- `launch.sh`：macOS / Linux 的 Node.js 自动定位入口，兼容常见用户级安装位置。
- `抖音视频下载.app`：macOS 的相对路径启动入口。

实际画质取决于平台公开提供的视频流。需要登录、验证、会员或非公开的作品可能无法下载；程序不会自动读取浏览器 Cookie。已下载视频、本地依赖、工具缓存和验证产物不纳入 Git。
