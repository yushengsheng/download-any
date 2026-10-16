# 下载工具来源与许可

项目不把下载工具二进制纳入 Git。运行时优先复用用户安装的工具，缺少时才下载固定版本，并按 `tools-manifest.json` 校验 SHA-256。清单中的校验值来自对应 GitHub Release 的资产摘要；升级时必须重新验证实际下载和合并行为。

- **yt-dlp 2026.08.19**：[项目与许可](https://github.com/yt-dlp/yt-dlp/tree/2026.08.19)、[发行二进制](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)。yt-dlp 源码为 Unlicense，打包的独立可执行文件包含其他许可组件，按上游说明适用 GPLv3+。
- **FFmpeg / ffprobe，ffmpeg-static b6.1.1**：[构建项目](https://github.com/eugeneware/ffmpeg-static)、[固定发行及各平台 LICENSE / README](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)。各平台构建配置和许可不同，以该发行中的平台 LICENSE、README 为准，使用的构建可能包含 GPL 组件。[FFmpeg 许可说明](https://ffmpeg.org/legal.html)。

如再分发这些二进制，请同时遵守对应上游的许可、源码提供和通知要求。
