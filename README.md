# 抖音视频下载

本地 macOS 抖音视频下载工具，使用 Node.js、Playwright 和 Google Chrome 解析视频并保存为 MP4。

## 使用方式

- 双击 `双击运行下载.command` 或 `抖音视频下载.app`，粘贴视频链接或手机端复制的分享文案。
- 也可以在项目目录通过终端运行：

  ```sh
  ./download_douyin.sh 'https://www.douyin.com/video/视频编号'
  ```

图形界面调用 `download_douyin_core.js`，尝试从页面接口或视频响应中选择较高码率的视频流，并按视频描述命名文件。终端脚本将视频保存到当前工作目录。

## 运行环境

当前版本保留原有本机配置，尚未提供自动安装或跨机器适配。需要 macOS、Google Chrome、Node.js 和 Playwright；代码中使用以下固定路径：

| 用途 | 当前路径 |
| --- | --- |
| Node.js | `/Users/ys/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin/node` |
| Node.js 依赖 | `/Users/ys/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules` |
| Chrome | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| 图形界面调用的脚本 | `/Users/ys/Downloads/视频下载/download_douyin_core.js` |
| 图形界面下载目录 | `/Users/ys/Downloads/视频下载` |

迁移到其他电脑或目录时，需要调整脚本和 App 内 AppleScript 中的对应路径。视频是否可以解析取决于作品访问状态及抖音页面行为，当前版本不保证所有链接均可下载。

## 项目文件

- `download_douyin.sh`：终端下载入口。
- `download_douyin_core.js`：图形界面使用的下载逻辑。
- `双击运行下载.command`：打开 macOS App 的快捷入口。
- `抖音视频下载.app`：链接输入、下载结果提示和文件定位界面。

已下载视频、本地依赖及临时文件不纳入版本管理。
