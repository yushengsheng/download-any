const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

const windowsScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$isFile = $env:DOWNLOAD_ANY_PICKER_KIND -eq 'file'
if ($isFile) {
  $dialog = [System.Windows.Forms.OpenFileDialog]::new()
  $dialog.Title = '选择需要分离音画的视频'
  $dialog.Multiselect = $false
  $dialog.CheckFileExists = $true
  $dialog.InitialDirectory = $env:DOWNLOAD_ANY_PICKER_DIR
  $dialog.Filter = '视频文件|*.mp4;*.m4v;*.mov;*.mkv;*.avi;*.webm;*.flv;*.ts;*.m2ts;*.mts;*.mpeg;*.mpg;*.mpe;*.m2v;*.wmv;*.3gp;*.ogv;*.vob;*.mxf;*.asf;*.f4v;*.rm;*.rmvb;*.qt;*.divx;*.dat|所有文件|*.*'
} else {
  $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
  $dialog.Description = '选择视频保存目录'
  $dialog.ShowNewFolderButton = $true
  $dialog.SelectedPath = $env:DOWNLOAD_ANY_PICKER_DIR
}
$owner = [System.Windows.Forms.Form]::new()
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    if ($isFile) { [Console]::Write($dialog.FileName) }
    else { [Console]::Write($dialog.SelectedPath) }
  }
} finally { $dialog.Dispose(); $owner.Dispose() }
`;

const macScript = `
on run argv
  activate
  try
    set initialFolder to POSIX file (item 1 of argv) as alias
    if (item 2 of argv) is "file" then
      set chosenPath to choose file with prompt "选择需要分离音画的视频" default location initialFolder
    else
      set chosenPath to choose folder with prompt "选择视频保存目录" default location initialFolder
    end if
    return POSIX path of chosenPath
  on error messageText number errorNumber
    if errorNumber is -128 then return ""
    error messageText number errorNumber
  end try
end run
`;

async function choosePath(currentDirectory, { signal, file = false } = {}) {
  let initialDirectory = os.homedir();
  try { if (fs.statSync(currentDirectory).isDirectory()) initialDirectory = currentDirectory; } catch {}
  const options = { encoding: "utf8", windowsHide: true, timeout: 300000, maxBuffer: 16384, signal };
  try {
    let result;
    if (process.platform === "win32") {
      const executable = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
      result = await run(executable, ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")], {
        ...options, env: { ...process.env, DOWNLOAD_ANY_PICKER_DIR: initialDirectory, DOWNLOAD_ANY_PICKER_KIND: file ? "file" : "directory" }
      });
    } else if (process.platform === "darwin") {
      result = await run("/usr/bin/osascript", ["-e", macScript, initialDirectory, file ? "file" : "directory"], options);
    } else {
      throw new Error(`当前系统请直接输入${file ? "视频文件" : "文件夹"}路径。`);
    }
    return result.stdout.replace(/[\r\n]+$/, "") || null;
  } catch (error) {
    signal?.throwIfAborted();
    if (process.platform === "linux") throw error;
    throw new Error(`未能完成${file ? "视频文件" : "文件夹"}选择，请重试或直接输入路径。`);
  }
}

function chooseDirectory(directory, options) { return choosePath(directory, options); }
function chooseVideoFile(directory, options) { return choosePath(directory, { ...options, file: true }); }

module.exports = { chooseDirectory, chooseVideoFile };
