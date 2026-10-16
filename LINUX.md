# Linux 服务器部署

服务器临时下载、合并或分离视频，最终结果由访问者的浏览器保存到自己的设备。工具箱通过网页选择本地视频上传，处理完成后分别下载画面与音频。服务器不会访问访问者电脑的文件路径，也不能替浏览器记忆电脑上的保存目录；可在浏览器设置里开启「下载前询问保存位置」。

无需购买域名，默认使用 `http://服务器公网IP:8686`。访问前输入密码，接口及下载链接也必须登录。密码为加盐 scrypt 哈希，不保存明文；登录会话默认 12 小时，连续失败会暂时限制尝试。一个密码对应一个私人服务，登录者共享任务记录，不是多租户账号系统。

## 一键部署

支持 **Ubuntu 22.04 / 24.04、Debian 12 / 13，x86_64 / ARM64，systemd**。需要 sudo / root、可访问 GitHub、npm、Node.js 和 Playwright 下载源；建议至少 2 GB 内存和 10 GB 可用磁盘。云服务器安全组需放行 TCP 8686，脚本无法替你修改云厂商控制台的安全组。

在 **Linux 服务器的 SSH 终端**执行下面这一整行。只替换最后的三个参数：

```bash
curl -fL --connect-timeout 20 --max-time 120 --retry 2 https://raw.githubusercontent.com/yushengsheng/download-any/main/deploy-linux.sh -o /tmp/download-any-deploy.sh && sudo bash /tmp/download-any-deploy.sh 你的服务器公网IP 8686 '你的自定义密码至少12位'
```

| 参数 | 填写方式 | 示例 |
| --- | --- | --- |
| 公网 IP | 只填服务器 IP，不加 `http://` 或端口 | `203.0.113.10` |
| 端口 | 1～65535 的数字，并在安全组放行同一 TCP 端口 | `8686` |
| 自定义密码 | 至少 12 个字符，最多 512 字节；保留英文单引号 | `'MyVideoPass2026!'` |

完整示例（IP 和密码是示例，安装前请换成自己的）：

```bash
curl -fL --connect-timeout 20 --max-time 120 --retry 2 https://raw.githubusercontent.com/yushengsheng/download-any/main/deploy-linux.sh -o /tmp/download-any-deploy.sh && sudo bash /tmp/download-any-deploy.sh 203.0.113.10 8686 'MyVideoPass2026!'
```

如果已经下载脚本，只需要：

```bash
sudo bash /tmp/download-any-deploy.sh 你的服务器公网IP 8686 '你的自定义密码至少12位'
```

部署成功后，在电脑浏览器输入 `http://你的服务器公网IP:端口`，使用命令中自己设置的密码登录，不需要用户名。**首次安装必须自定义密码，不再生成随机密码，也没有通用默认密码。** 填错参数或密码太短时，脚本会在安装前提示错误。

脚本会安装系统依赖、独立 Node.js 24 LTS、FFmpeg、固定版本 yt-dlp 与 Chromium，校验工具安装包，执行测试和浏览器检查，然后配置专用用户及 systemd 开机自启。配置文件仅保存加盐后的密码哈希，不保存或打印明文密码。官方 Node.js 安装包按同一官方 HTTPS 来源的 SHA-256 清单校验。

密码用英文单引号包住时，空格、`!`、`$` 和反引号都会按原样传入。密码本身含有单引号，或不想将密码写进命令历史时，可先隐藏输入，再用变量传入：

```bash
read -rs -p '设置访问密码（至少12字符）: ' DEPLOY_PASSWORD; echo
sudo bash /tmp/download-any-deploy.sh 你的服务器公网IP 8686 "$DEPLOY_PASSWORD"
unset DEPLOY_PASSWORD
```

直接把密码填在命令中时，终端历史和进程参数可能记录它；隐藏输入方式可避免把密码内容写进命令历史。

默认安装根目录为 `/opt/download-any`，可自定义到任何适合服务运行的专用空目录，支持空格。程序内部根据安装根目录和配置自动计算路径。不要将安装目录放到只允许个人用户访问的家目录中，专用服务用户需要遍历上级目录。

```bash
sudo env INSTALL_DIR="/srv/my video tools" bash /tmp/download-any-deploy.sh 你的服务器公网IP 8686 '你的自定义密码至少12位'
```

IPv6 可以直接填写地址或加方括号，访问网址会自动加方括号。可用 `REPO_URL`、`BRANCH` 指定其他仓库/分支，用 `SERVICE_NAME`、`SERVICE_USER` 指定服务名和专用用户。一个安装目录只能运行一个实例。高级用法保留 `PUBLIC_URL`、`BIND_HOST`，首次部署也兼容 `SERVER_ADDRESS`、`PORT`、`DOWNLOAD_ANY_PASSWORD` 环境变量；推荐使用上面的三个参数格式。

## 更新与回滚

更新 GitHub 后，**再次运行同一条部署命令**。带 IP、端口和密码的命令会应用本次填写的新设置，包括修改已有密码；不带参数运行则保留原来的设置，只更新程序：

```bash
curl -fL --connect-timeout 20 --max-time 120 --retry 2 https://raw.githubusercontent.com/yushengsheng/download-any/main/deploy-linux.sh -o /tmp/download-any-deploy.sh && sudo bash /tmp/download-any-deploy.sh
```

如果首次使用了 `INSTALL_DIR` 等选项，更新时保持一致。脚本读取远程分支、按 commit 建立独立版本目录，验证通过后才切换 `current` 并重启服务；启动检查失败自动切回上一版及配置。默认只保留当前与上一版代码。新版本准备期间旧服务继续运行，最终切换会取消尚未完成的任务。

`data/server.json`、工具缓存和浏览器保留在代码目录之外，不被更新覆盖。专用服务用户的 HOME、浏览器配置与缓存也自动放在此数据目录中，不依赖安装者的个人目录；回滚后同样检查旧服务是否恢复。服务重启后浏览器需要重新登录，尚未保存的临时视频会清理，因此更新前先把需要的结果下载到电脑。

## 临时文件规则

- 上传文件处理完毕即删除；失败或取消时清理本次临时任务。
- 工具箱只接收常见视频容器，拒绝 HLS/concat 等外部引用播放列表，禁止借上传文件读取任意服务器路径。
- 成功结果默认保留 **2 小时**，到期后每分钟清理；正在传输的文件等待传输结束再删。
- 结果完整传给浏览器后，保留时间缩短为 **5 分钟**，供浏览器保存失败时重试，之后在每分钟的清理任务中自动删除。音画分离等画面、音频两个文件都完整传完后才开始缩短期限；HTTP 断点续传会合并已完成的范围，中断的请求不算完成。重复下载不无限延长占用。
- 页面可手动清除已保存的服务器结果。结果到期后需要重新下载或重新上传处理。
- 服务启动时清理专用缓存中的旧任务，防止异常退出遗留视频。其他目录与非任务文件不删除。
- 正常停止服务时清理剩余临时任务；异常退出留下的文件在下次启动时清理。浏览器、FFmpeg 和下载子进程在任务结束或取消后关闭，不为空闲任务继续占用处理资源。
- 默认单个输入最大 **2 GiB**，总结果缓存 **10 GiB**，最多保留 20 个任务；一次处理一个任务。空间紧张时会降低当前任务上限或拒绝任务，不删除尚未过期的结果来腾空间。
- 上传和处理都有 2 小时上限，上传闲置 60 秒断开。网页下载支持 HTTP Range，文件未过期时可断点读取。

任务完成后普通视频会尝试自动开始浏览器下载，浏览器拦截时点击「保存到我的设备」。音画分离产生两个文件，分别点击结果链接保存，避免浏览器拦截多文件自动下载。

## 管理

```bash
sudo systemctl status download-any
sudo journalctl -u download-any -n 100 --no-pager
sudo systemctl restart download-any
sudo systemctl stop download-any
```

修改 IP、端口或密码，重跑带三个参数的部署命令即可，例如：

```bash
sudo bash /tmp/download-any-deploy.sh 203.0.113.10 8686 'AnotherVideoPass2026!'
```

只修改密码且不重新部署代码，可以使用隐藏输入（默认路径；自定义目录时替换根目录）：

```bash
read -rs -p '新密码（至少12字符）: ' NEW_PASSWORD; echo
printf '%s' "$NEW_PASSWORD" | sudo /opt/download-any/runtime/bin/node \
  /opt/download-any/current/server-config.js --config /opt/download-any/data/server.json \
  --reset-password --password-stdin
unset NEW_PASSWORD
sudo systemctl restart download-any
```

配置文件 `data/server.json` 可调整 `port`、`bind`、`publicUrl`、`retentionHours`、`downloadedRetentionMinutes`、`maxFileMiB`、`maxCacheMiB`，修改后重启。`downloadedRetentionMinutes` 默认 5，可设为 0～60 分钟；0 表示完整传输后进入下一次清理，正在传输的文件仍受保护。浏览器收到完整数据不代表本机磁盘一定保存成功，建议保留默认的重试时间。`publicUrl` 必须与浏览器实际访问的地址一致（含端口），否则来源检查会拒绝请求。更换端口后另行放行对应安全组/防火墙端口。不要将包含密码哈希的配置提交到 Git。

## HTTP 与 HTTPS

**密码登录限制谁能使用，但 HTTP 本身不加密密码、Cookie 和视频。** 默认 IP + HTTP 适合可信网络。公网加密访问可自行配置 HTTPS 反向代理及受信任证书（可使用支持 IP 证书的签发服务，不必买域名），将 `publicUrl` 改为 HTTPS 地址、`bind` 改为 `127.0.0.1`；代理需保留原始 Host，并允许大文件与长上传超时。HTTPS 模式 Cookie 自动设置 Secure。

也可无需域名/证书，通过 SSH 隧道访问：

```bash
ssh -N -L 8686:127.0.0.1:8686 用户名@服务器IP
```

电脑浏览器打开 `http://127.0.0.1:8686`，外部链路由 SSH 加密。服务器最好绑定 `127.0.0.1` 并关闭公网 8686 入站。

## 限制与验证

服务器下载成功率还取决于服务器所在地区、平台风控和作品权限。数据中心 IP 可能遇到抖音/B站登录或验证要求；本地成功不等于每台服务器都能成功，程序不会绕过验证或会员权限。

自动化测试覆盖登录、会话过期/退出、来源校验、上传实际分离、文件下载、断点读取、取消、配额和缓存清理；缓存满后仍保留旧结果的下载与清除入口。本地文件选择也验证了超过普通接口超时后的正常返回。部署脚本经过 Bash 语法和 ShellCheck 检查，安装前还通过 systemd 检查服务文件。脚本会在目标机实际执行依赖、测试、浏览器和服务健康检查，失败即停止或恢复上一版，并保留错误信息。

仓库附带 GitHub Actions 的 Ubuntu 22.04 / 24.04 验证任务，自动安装 FFmpeg、Chromium 并运行测试与浏览器检查；另在 Ubuntu 24.04 上实际运行部署脚本，检查首次安装、修改密码、IPv6 访问、不可用监听地址触发的回滚，以及包含空格、`$`、`%` 的安装目录。这些检查仍不能替代你实际云服务器的网络、权限与平台风控验证；Debian、ARM64 和 macOS 的完整运行环境未在本机实测。
