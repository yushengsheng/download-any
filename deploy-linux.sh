#!/usr/bin/env bash
# Download Any: managed single-server deployment (Debian/Ubuntu + systemd).
set -Eeuo pipefail
umask 027
die() { printf '%s\n' "部署失败：$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
用法：sudo bash deploy-linux.sh 公网IP 端口 '自定义密码'
示例：sudo bash deploy-linux.sh 203.0.113.10 8686 'MyVideoPass2026!'
密码至少 12 个字符，最多 512 字节。请替换示例 IP 和密码。
首次安装须设置密码；已有安装也可不带参数运行，只更新程序并保留设置。
USAGE
}
if [[ $# == 1 && ( $1 == --help || $1 == -h ) ]]; then usage; exit 0; fi
[[ $# == 0 || $# == 3 ]] || { usage >&2; die '需要按顺序填写 IP、端口、密码，共三个参数。'; }
has_parameters=0
has_password=0
deploy_password=${DOWNLOAD_ANY_PASSWORD-}
[[ ! ${DOWNLOAD_ANY_PASSWORD+x} ]] || has_password=1
unset DOWNLOAD_ANY_PASSWORD
if [[ $# == 3 ]]; then
  has_parameters=1
  deploy_address=$1
  deploy_port=$2
  deploy_password=$3
  has_password=1
  set --
  deploy_address=${deploy_address#[}
  deploy_address=${deploy_address%]}
  [[ $deploy_address =~ ^[0-9A-Fa-f:.]+$ ]] || die 'IP 格式不正确，只填写公网 IP，不要加 http:// 或端口。'
  if [[ $deploy_address != *:* ]]; then
    [[ $deploy_address =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'IPv4 地址格式不正确。'
    IFS=. read -r -a address_parts <<< "$deploy_address"
    for part in "${address_parts[@]}"; do
      if [[ $part != 0 && $part == 0* ]] || (( 10#$part > 255 )); then die 'IPv4 地址格式不正确。'; fi
    done
  else
    [[ $deploy_address == *:*:* ]] || die 'IPv6 地址格式不正确。'
  fi
  if [[ ! $deploy_port =~ ^[0-9]{1,5}$ ]] || (( 10#$deploy_port < 1 || 10#$deploy_port > 65535 )); then die '端口必须为 1～65535 的数字。'; fi
  deploy_port=$((10#$deploy_port))
fi
if (( has_password )); then
  [[ ${#deploy_password} -ge 12 && $deploy_password != *$'\n'* && $deploy_password != *$'\r'* ]] || die '自定义密码至少 12 个字符，且不能包含换行。'
  password_bytes=$(LC_ALL=C printf '%s' "$deploy_password" | wc -c)
  (( password_bytes <= 512 )) || die '自定义密码最多 512 字节。'
fi
[[ $(uname -s) == Linux ]] || die '此脚本需要在 Linux 服务器运行。'
[[ $EUID == 0 ]] || die '请使用 sudo bash deploy-linux.sh 运行。'
if ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]]; then die '需要使用 systemd 的 Linux 系统。'; fi
# shellcheck source=/dev/null
source /etc/os-release
case "${ID}:${VERSION_ID}" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) die '当前一键部署支持 Ubuntu 22.04/24.04、Debian 12/13。' ;; esac
case $(uname -m) in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die '支持 x86_64 或 ARM64 服务器。' ;; esac
repo=${REPO_URL:-https://github.com/yushengsheng/download-any.git}
branch=${BRANCH:-main}
service=${SERVICE_NAME:-download-any}
account=${SERVICE_USER:-download-any}
requested=${INSTALL_DIR:-/opt/download-any}
[[ $service =~ ^[a-z][a-z0-9-]{0,40}$ && $account =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die '服务名或用户名称无效。'
[[ $requested == /* && $requested != *$'\n'* && $requested != *$'\r'* ]] || die 'INSTALL_DIR 需要是有效的绝对目录。'
if (( ! has_password )) && [[ ! -f $requested/data/server.json ]]; then
  usage >&2
  die '首次部署必须填写自定义密码，不再自动生成随机密码。'
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils util-linux ffmpeg
git check-ref-format --branch "$branch" >/dev/null || die 'BRANCH 无效。'
mkdir -p -- "$requested"
root=$(realpath -- "$requested")
case $root in /|/etc|/usr|/var|/home|/root|/opt) die '请选择程序专用的子目录。' ;; esac
if [[ ! -f $root/.download-any-install ]]; then
  [[ -z $(find "$root" -mindepth 1 -maxdepth 1 -print -quit) ]] || die '安装目录已有其他内容，请指定一个空目录。'
  printf '%s\n' 'Managed by download-any deploy-linux.sh' > "$root/.download-any-install"
fi
exec 9> "$root/.deploy.lock"
flock -n 9 || die '另一个部署正在进行，请等待完成。'
data=$root/data
[[ ! -L $data && ! -L $root/releases && ! -L $root/runtimes ]] || die '程序数据与版本目录不能是符号链接。'
mkdir -p -- "$data" "$root/releases" "$root/runtimes"
chmod 755 "$root" "$root/releases" "$root/runtimes"
id "$account" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$data" --shell /usr/sbin/nologin "$account"
[[ $(id -u "$account") != 0 ]] || die '服务必须使用专用非 root 用户。'
service_group=$(id -gn "$account")
chown -R "$account:$service_group" "$data"
chmod 700 "$data"
unit=/etc/systemd/system/$service.service
if [[ -f $unit ]]; then
  grep -Fxq "# Install root: $root" "$unit" || die '同名服务属于其他目录，请使用原目录或设置 SERVICE_NAME。'
fi
work=$(mktemp -d "$root/.deploy.XXXXXXXX")
old=$(readlink "$root/current" 2>/dev/null || true)
activated=0
had_config=0
[[ ! -f $data/server.json ]] || { cp -- "$data/server.json" "$work/previous-config.json"; had_config=1; }
[[ ! -f $unit ]] || cp -- "$unit" "$work/previous.service"
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    if (( had_config )); then install -o "$account" -g "$service_group" -m 600 "$work/previous-config.json" "$data/server.json"; fi
    if (( activated )) && [[ -n $old ]]; then
      ln -s -- "$old" "$work/rollback"
      mv -Tf -- "$work/rollback" "$root/current"
      [[ ! -f $work/previous.service ]] || cp -- "$work/previous.service" "$unit"
      systemctl daemon-reload
      systemctl restart "$service" || true
      printf '%s\n' '已恢复上一版本，请查看上方错误后重试。' >&2
    elif (( activated )); then systemctl stop "$service" || true; fi
  fi
  # work is created by mktemp strictly inside this managed install root.
  [[ $work == "$root"/.deploy.* && -d $work && ! -L $work ]] && rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
fetch() { curl --fail --location --silent --show-error --connect-timeout 20 --max-time 300 --retry 2 --retry-delay 2 "$@"; }
if [[ ! -x $root/runtime/bin/node ]]; then
  fetch https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$work/sums"
  read -r checksum archive < <(awk -v a="$arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" a "\\.tar\\.xz$") {print $1, $2; exit}' "$work/sums")
  [[ ${archive:-} =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ && ${checksum:-} =~ ^[a-f0-9]{64}$ ]] || die '无法确认官方 Node.js 安装包。'
  version=${archive#node-}; version=${version%-linux-*}
  fetch "https://nodejs.org/dist/$version/$archive" -o "$work/$archive"
  (cd "$work" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -)
  runtime=$root/runtimes/${archive%.tar.xz}
  mkdir -p -- "$runtime"
  tar -xJf "$work/$archive" --strip-components=1 -C "$runtime"
  chmod -R a+rX "$runtime"
  [[ ! -e $root/runtime || -L $root/runtime ]] || die 'runtime 已被其他文件占用。'
  ln -s -- "$runtime" "$work/runtime"
  mv -Tf -- "$work/runtime" "$root/runtime"
fi
node=$root/runtime/bin/node
export PATH="$root/runtime/bin:$PATH"
[[ $("$node" -p 'Number(process.versions.node.split(".")[0]) >= 22') == true ]] || die '服务器需要 Node.js 22 或更新版本。'
if (( has_parameters )); then
  "$node" -e 'if (!require("node:net").isIP(process.argv[1])) { console.error("IP 格式不正确。"); process.exit(1); }' "$deploy_address"
fi
if [[ ! -d $root/repository.git ]]; then
  git init --bare "$root/repository.git" >/dev/null
  git --git-dir="$root/repository.git" remote add origin "$repo"
fi
git --git-dir="$root/repository.git" remote set-url origin "$repo"
GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 --git-dir="$root/repository.git" fetch --depth=1 origin "$branch"
revision=$(git --git-dir="$root/repository.git" rev-parse FETCH_HEAD)
[[ $revision =~ ^[a-f0-9]{40}$ ]] || die 'Git 版本编号无效。'
release=$root/releases/$revision
if [[ ! -f $release/.ready ]]; then
  [[ ! -e $release ]] || die '发现不完整版本目录，请检查后移走该目录再部署。'
  stage=$work/app
  mkdir "$stage"
  git --git-dir="$root/repository.git" archive "$revision" | tar -x -C "$stage"
  [[ -f $stage/server-config.js && -f $stage/package-lock.json ]] || die 'GitHub 上尚未包含服务器版代码，请先提交并推送。'
  chown -R "$account:$service_group" "$stage"
  chmod 755 "$root" "$work"
  # The caller may be in /root or another home the service account cannot traverse.
  as_service() { (cd "$stage" && runuser -u "$account" -- env PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH="$data/browsers" DOWNLOAD_ANY_TOOLS_DIR="$data/tools" "$@"); }
  as_service "$root/runtime/bin/npm" ci --omit=dev --no-audit --no-fund
  "$node" "$stage/node_modules/playwright-core/cli.js" install-deps chromium
  as_service "$node" "$stage/node_modules/playwright-core/cli.js" install chromium --no-shell
  as_service "$node" -e 'require(process.argv[1]).ensureBilibiliTools({onLog:console.log}).catch(e=>{console.error(e.message);process.exitCode=1})' "$stage/download-tools.js"
  as_service "$root/runtime/bin/npm" test
  as_service "$node" "$stage/start.js" --check
  touch "$stage/.ready"
  chown -R root:root "$stage"
  chmod -R 'go-w,a+rX' "$stage"
  mv -- "$stage" "$release"
fi
if (( has_parameters )) || [[ ! -f $data/server.json ]]; then
  export DOWNLOAD_ANY_PORT=${deploy_port:-${PORT:-8686}}
  if [[ -n ${PUBLIC_URL:-} ]]; then export DOWNLOAD_ANY_PUBLIC_URL=$PUBLIC_URL
  else
    address=${deploy_address:-${SERVER_ADDRESS:-$(curl -4fsS --connect-timeout 5 --max-time 10 https://api.ipify.org || true)}}
    [[ -n $address ]] || die '无法检测公网 IP，请设置 SERVER_ADDRESS=服务器IP 后重试。'
    if [[ $address == *:* && $address != "["* ]]; then address="[$address]"; fi
    export DOWNLOAD_ANY_PUBLIC_URL=http://$address:$DOWNLOAD_ANY_PORT
  fi
  default_bind=0.0.0.0
  [[ ${address:-${deploy_address:-}} != *:* ]] || default_bind=::
  export DOWNLOAD_ANY_BIND=${BIND_HOST:-$default_bind}
fi
if (( has_password )); then
  printf '%s' "$deploy_password" | "$node" "$release/server-config.js" --config "$data/server.json" --password-stdin
  unset deploy_password
else
  "$node" "$release/server-config.js" --config "$data/server.json"
fi
chown "$account:$service_group" "$data/server.json"
port=$("$node" -e 'console.log(require(process.argv[1]).port)' "$data/server.json")
public_url=$("$node" -e 'console.log(require(process.argv[1]).publicUrl)' "$data/server.json")
quote_unit() { local text=$1; text=${text//\\/\\\\}; text=${text//\"/\\\"}; text=${text//%/%%}; printf '"%s"' "$text"; }
{
  printf '# Managed by download-any deploy-linux.sh\n# Install root: %s\n' "$root"
  printf '[Unit]\nDescription=Download Any private video tools\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=%s\nGroup=%s\n' "$account" "$service_group"
  # WorkingDirectory is a single literal path, unlike the word lists below.
  printf 'WorkingDirectory=%s/current\n' "${root//%/%%}"
  # ':' disables systemd environment substitution in paths containing a literal '$'.
  printf 'ExecStart=:%s %s --server --config %s\n' "$(quote_unit "$node")" "$(quote_unit "$root/current/start.js")" "$(quote_unit "$data/server.json")"
  printf 'Environment=%s\n' "$(quote_unit "PATH=$root/runtime/bin:/usr/local/bin:/usr/bin:/bin")"
  printf 'Environment=%s\n' "$(quote_unit "PLAYWRIGHT_BROWSERS_PATH=$data/browsers")"
  if (( port < 1024 )); then printf 'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n'; fi
  printf 'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%s\nLimitNOFILE=4096\n[Install]\nWantedBy=multi-user.target\n' "$(quote_unit "$data")"
} > "$work/new.service"
systemd-analyze verify "$work/new.service"
activated=1
install -m 644 "$work/new.service" "$unit"
ln -s -- "$release" "$work/current"
mv -Tf -- "$work/current" "$root/current"
systemctl daemon-reload
systemctl enable "$service" >/dev/null
systemctl restart "$service"
healthy=0
for ((attempt=0; attempt<30; attempt++)); do
  if systemctl is-active --quiet "$service" && curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then healthy=1; break; fi
  sleep 1
done
(( healthy )) || { journalctl -u "$service" -n 30 --no-pager >&2; die '服务健康检查未通过。'; }
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow "$port/tcp"; fi
# Retain the active and previous release; only remove marked, managed commit directories.
for candidate in "$root"/releases/*; do
  [[ -d $candidate && ! -L $candidate && -f $candidate/.ready && ${candidate##*/} =~ ^[a-f0-9]{40}$ ]] || continue
  [[ $candidate == "$release" || $candidate == "$old" ]] || rm -rf -- "$candidate"
done
printf '\n部署成功：%s\n临时文件默认保留 2 小时，结果由浏览器保存到访问者设备。\n' "$public_url"
if (( has_password )); then printf '%s\n' '访问密码：使用你本次设置的自定义密码。'; fi
printf '请在云服务器安全组放行 TCP %s。查看运行状态：systemctl status %s\n' "$port" "$service"
printf '%s\n' "更新并保留设置：sudo bash deploy-linux.sh" "修改 IP、端口或密码：sudo bash deploy-linux.sh 公网IP 端口 '自定义密码'"
printf '%s\n' 'HTTP 不加密传输；公网敏感使用请配置 HTTPS，或通过 SSH 隧道访问。无需购买域名。'
