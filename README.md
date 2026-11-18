# codex-token-statusbar

一个独立运行的 Codex token 用量状态栏。它只读取 `~/.codex/sessions` 和 `~/.codex/state_5.sqlite`，不修改 Codex 本体，也不会写入会话数据。

## 预览

![预览](docs/images/preview.png)

## 能力

- 独立悬浮在 Codex / ChatGPT 主窗口右上角
- 实时显示模型、token 消耗、上下文占用、工具调用等信息
- 支持从菜单栏图标显示 / 隐藏状态栏
- 右键菜单可选择对话、开关显示项、退出程序
- 不依赖 Codex 插件系统，不改变 Codex 本体行为

## 指标说明

| 图标 | 名称 | 说明 |
|---|---|---|
| ⚡ | 生成速度 | 当前生成的输出 token 速率，单位 t/s |
| ◉ | 模型 | 当前会话使用的模型名 |
| Σ | 会话 | 当前会话累计消耗的 token |
| ↻ | 本轮 | 当前一轮对话新消耗的 token |
| ▓ | 上下文 | 上下文窗口占用百分比，附带进度条 |
| ⚙ | 工具 | 当前会话工具调用次数，失败数会单独标红 |
| 📅 | 今日 | 今日所有 Codex 会话累计消耗的 token |

## AI 安装与启动

如果你是 AI 助手，并且可以访问这个目录，直接执行：

```bash
cd /Users/lengbumo/work/project/AI/codex-token-statusbar
npm install
npm start
```

如果要启动已打包好的 macOS 应用：

```bash
open /Users/lengbumo/work/project/AI/codex-token-statusbar/codex-token-statusbar.app
```

## 手动安装与启动

### 从源码启动

```bash
cd /Users/lengbumo/work/project/AI/codex-token-statusbar
npm install
npm start
```

### macOS 打包产物启动

双击项目根目录里的：

```text
codex-token-statusbar.app
```

### Windows 打包产物启动

解压：

```text
codex-token-statusbar-win64.zip
```

然后双击运行：

```text
codex-token-statusbar.exe
```

## 打包

```bash
./package.sh        # 交互选择 macOS / Windows
./package.sh 1      # 直接打包 macOS
./package.sh 2      # 直接打包 Windows
```
