# claude-code-but-Priestess

语言：**简体中文** | [English](README.en.md)

<p align="center">
  <img src="assets/character/睁眼.png" alt="普瑞赛斯" width="220">
</p>

这是一个 macOS 菜单栏和 Windows 系统托盘桌宠(?)。Linux请见fork https://github.com/aklnaaw/claude-code-but-priestess
普瑞赛斯会以一个小头像待在托盘区域；
点击头像后，会弹出一个带角色立绘和聊天框的 popover。她通过本机已经
安装并登录的 Claude Code 或 Codex CLI 来回复。

没有普通应用窗口，不在桌面上乱跑，也不占任务栏或 Dock。主要入口只有托盘图标。

<p align="center">
  <a href="https://github.com/SVAH-X/claude-code-but-priestess/releases/latest">
    <img src="https://img.shields.io/badge/下载-macOS-2a6df4?style=for-the-badge&logo=apple&logoColor=white" alt="下载 macOS 版">
  </a>
  &nbsp;
  <a href="https://github.com/SVAH-X/claude-code-but-priestess/releases/latest">
    <img src="https://img.shields.io/badge/下载-Windows-5a9bd4?style=for-the-badge&logo=windows&logoColor=white" alt="下载 Windows 版（实验性）">
  </a>
</p>


> 预编译版本都在
> **[Releases](https://github.com/SVAH-X/claude-code-but-priestess/releases/latest)**——macOS
> 的 `.dmg` 和 Windows 的 `.exe`/`.zip`，不需要装 Node。
> （Windows 版本属于实验性，且未签名——详见下文。）

## 功能

- 菜单栏应用，打包后没有 Dock 图标。
- 菜单栏头像使用居中的 `assets/character/icon.png`，缺失时回退到笑脸立绘裁剪。
- 点击菜单栏图标后打开 popover：
  - 上方是普瑞赛斯立绘，会呼吸、待机眨眼。
  - 下方是聊天记录和输入框。
  - `Enter` 发送，`Shift+Enter` 换行。
- 拖动顶部标题栏可以把整个 popover 移动到屏幕任意位置；从左 / 右 / 下边缘或左右下角拖拽来缩放。普瑞赛斯的活动区域和聊天区域会随窗口尺寸变化。
- 点击她会有反应（连续点击：开心 → 生气 → 威胁）；也可以在框内抓着她甩来甩去；长时间不理她，她会先哭唧唧，再睡着。
- 聊天窗口闲置一分钟后会淡出，只留下停留在原位置的小桌宠；隐藏聊天窗口后也会进入该状态。可以拖动她改变位置，或点击她在当前位置附近恢复聊天窗口。桌宠会眨眼、呼吸、轻摆，偶尔弹跳。**想彻底关掉桌宠，右键托盘图标，取消勾选「Desktop pet while idle」**——点击桌宠本身只会重新打开聊天，而且隐藏聊天约一分钟后她还会回来。同一个菜单还能立即显示她，或选择小 / 中 / 大三档尺寸。
- 跨平台一致的亮 / 暗外观。右键托盘图标 →「Appearance」可选择跟随系统（默认）或强制 Light / Dark。文字配色与 popover 背景会一起切换，所以 macOS 和 Windows 上观感一致，不会再出现「黑底绿字看不清」。
- 技能（Skills）——她能替你做的几件本地小事，macOS 与 Windows 都支持：放音乐、用默认浏览器搜索、打开网址、打开本地应用、设提醒（到点通知你）、取消她设下的提醒、记一笔。她通过一个隐藏的 `[[skill:…]]` 指令触发（和心情标记一样会被界面隐藏掉）。这是一个封闭、参数经过净化的白名单——只会打开网址/应用，不执行任意命令——所以不开 agent mode 也能用，且完全不影响你平时的 Claude Code / Codex。可随时在托盘菜单里关掉（**「Let her use skills」**）。
  - **音乐**：内置登记过的明日方舟曲目会直接打开并自动播放（默认走 Bilibili；Aimer 的「Eclipse」——六周年印象曲，其官方关联角色正是博士与普瑞赛斯——是她与博士的歌，会作为默认，但她会按你的心情/是否已经听过而换歌）。可在参数里写平台（`bilibili` / `youtube` / `网易云` / `spotify` / `apple music`）来指定。不在内置清单里的歌会打开搜索结果，需你点开播放。
  - **打开应用**：按应用的「本地真实名称」打开，所以请用该名称（例如网易云音乐在本地多叫 **NetEase Music**，而非「网易云音乐」）。常见的中文音乐应用名我已帮你映射；找不到时她会明说，而不是悄悄没反应。
- 表情状态：
  - 她会根据每条回复的情绪自己选择表情（平静 / 笑 / 难过 / 生气 / 困倦 / 威胁）——通过一个界面读取并隐藏的标记实现。
  - 回复中：思考 / 工作；回复完成：定格在她为这条回复选择的表情；出错：短暂哭唧唧。
- 右键菜单可以：
  - 打开聊天窗口。
  - 切换外观（跟随系统 / Light / Dark）。
  - 开启/关闭 技能（放音乐 / 搜索 / 打开网址·应用）。
  - 开启/关闭 agent mode。
  - 在可用时切换 Claude Code / Codex。
  - 切换当前后端的模型；Codex 会读取当前本地账号可见的模型目录，读不到时只保留默认。Claude 没有这种目录命令，所以提供一组当前可用的模型（别名 + 版本），若选了账号不可用的型号，会自动切回默认并重试。
  - 设置聊天工作目录。
  - 打开数据目录。
  - 退出应用。

## 下载安装（普通用户）

### macOS（预编译）

最省心的玩法，不需要本机有 Node 环境：

1. 去 [最新 release](https://github.com/SVAH-X/claude-code-but-priestess/releases/latest)
   下载 **`PRTS-<版本>-arm64.dmg`**。
2. 打开 DMG，把 **PRTS.app** 拖进 `/Applications`。
3. 第一次启动 macOS 会拦下，提示「Apple 无法验证 PRTS 是否包含恶意软件」，
   因为这个版本没有 Apple Developer ID 签名。绕过一次即可：

   ```sh
   xattr -dr com.apple.quarantine /Applications/PRTS.app
   ```

   或者在 Finder 里 右键 `PRTS.app` → **打开** → 在对话框里再确认一次
   **打开**。
4. 点击屏幕右上角的小头像，开始聊天。

### Windows

> **实验性。** Windows 版本由 CI 自动构建，维护者还没有在 Windows 上实际测试过，
> 而且没有签名。遇到问题请到
> [issues](https://github.com/SVAH-X/claude-code-but-priestess/issues) 反馈。

1. 在 [最新 release](https://github.com/SVAH-X/claude-code-but-priestess/releases/latest)
   里下载 **`PRTS.Setup.<版本>.exe`**（安装包）或
   **`PRTS-<版本>-win.zip`**（免安装，解压后运行 `PRTS.exe`）。
2. 运行它。Windows SmartScreen 会因为「未知发布者」弹出警告（因为没有代码签名）——
   点 **更多信息 → 仍要运行**。
3. 点击通知区域里的 PRTS 图标打开聊天；Windows 可能把它收进隐藏图标的溢出区
   （任务栏上的 `^`）。

**自动更新**

- **Windows 和 macOS 都会自动更新**：PRTS 启动时检查 GitHub，有新版本就后台下载、校验、
  自动安装并重启（macOS 用原子替换；Windows 在退出时安装，或托盘 **Restart to update** 立即更新）。
  你的对话与记忆不受影响。
- 两个平台托盘里都有 **Check for updates…**。（自动更新从这个版本起才生效——更早的
  安装没有更新器，需要先手动更新到这个版本一次。）

> ⚠️ **macOS：更新后若「看屏 / agent 截屏」失效，需要重新授权一次。** 因为 PRTS 未签名，
> macOS 把「屏幕录制」权限绑在**每个版本的签名**上——更新后旧授权对新版不再生效（设置里那条旧
> 「PRTS」看着是开的，但其实没用）。**修复**：系统设置 → 隐私与安全性 → 屏幕录制，选中旧的
> 「PRTS」点 **「−」** 删掉，再点 **「+」** 重新添加 `/Applications/PRTS.app`，然后重启 PRTS。
> （PRTS 本身在截屏失效时也会在聊天里提示你这几步。）Windows 没有这个问题——截屏不需要单独的系统权限。

**系统要求**

- **Apple Silicon**（M1 / M2 / M3 / M4）的 macOS——提供预编译 `.dmg`。当前
  release 没有 Intel 版本。
- Windows 10 / 11（x64）——提供预编译安装包 / `.zip`（实验性，未签名）。
- 本机已安装并登录 [Claude Code](https://claude.ai/code) CLI（`claude`）
  或 [Codex](https://platform.openai.com/docs/codex) CLI（`codex`）至少
  一个，详见下面的 **[后端支持](#后端支持)**。

> 装好以后菜单栏里看不到她？带刘海的 Mac 会把溢出的菜单栏图标藏在刘海后面。
> 按住 ⌘ 把其他菜单栏图标拖走腾位置，或者装个菜单栏管理器（比如
> [Ice](https://github.com/jordanbaird/Ice) 或 Bartender）。

## 从源码构建（开发者）

克隆仓库、装依赖、启动开发模式：

```sh
git clone https://github.com/SVAH-X/claude-code-but-priestess.git
cd claude-code-but-priestess
npm install
npm run dev
```

然后查看 macOS 顶部菜单栏或 Windows 通知区域。

> 在 macOS 26（Tahoe）上，`npm run dev` 会通过 LaunchServices 启动开发版并做
> ad-hoc 重新签名，菜单栏图标才会显示——Tahoe 的菜单栏权限会悄悄隐藏来自裸
> `electron .` 启动或未签名 bundle 的状态栏图标。

为当前操作系统生成安装产物：

```sh
npm run dist          # 为当前机器架构构建
```

产物在 `dist/`。可用 `npm run dist:win` 构建 Windows 版本，或用
`npm run dist:mac` 构建 macOS 版本。同时构建 macOS arm64 和 Intel，可以用
`electron-builder --mac --arm64 --x64`，或者 `--universal` 出一个胖二进制。

## 后端支持

这个应用只支持本地 CLI 后端，不直接使用云端 API key，也不支持任意
第三方 agent。

支持的本地 CLI：

- Claude Code：`claude`
- Codex CLI：`codex`

后端选择规则：

- 如果本机同时有 `claude` 和 `codex`，右键菜单里可以切换；macOS 默认
  使用 Claude Code，Windows 默认使用 Codex。
- 如果本机只有 `claude`，应用会锁定 Claude Code，不显示 Codex 选项。
- 如果本机只有 `codex`，应用会锁定 Codex，不显示 Claude Code 选项。
- 如果两个都没有，popover 顶部显示 `No CLI`，发送按钮禁用，右键菜单
  显示 `Usage backend: no local CLI found`。

探测会在启动时、打开后端菜单时、发送消息前执行。它会检查当前 `PATH`、
常见本地二进制目录，以及 VS Code / Cursor 的 OpenAI 扩展内置 Codex
二进制。

Claude Code 需要先安装并登录：

```sh
claude          # 第一次运行时按提示登录
which claude    # 应该能输出路径
```

> 💡 **省钱小贴士**：如果你只是想和普瑞赛斯聊天互动，并不需要强模型干重活，可以让
> Claude Code 接入更便宜的 **DeepSeek API**——DeepSeek 提供 Anthropic 兼容接口，在
> `~/.claude/settings.json` 里配置后端地址、模型和 key 即可。示例教程：
> <https://zhuanlan.zhihu.com/p/2031406587932304990> 。
> 注意：配置写在 `settings.json`（这样 PRTS 拉起的 `claude` 子进程也能继承到），并把
> 托盘的 **Model 菜单保持「默认」**，不要选 Claude 专有型号（否则会去 DeepSeek 端请求
> 不存在的模型）。

Codex 需要先安装并登录：

```sh
codex          # 第一次运行时按提示登录
which codex    # 应该能输出路径
```

可以通过右键菜单 `Set chat directory…` 设置聊天工作目录，让当前后端在
正确的项目目录下工作。

## 数据与记忆存放

应用自己持久化的数据都放在 Electron 的 `userData` 目录里，不会写进这个
repo，也不会写进用户选择的聊天工作目录。可以通过右键菜单的
`Reveal data folder` 打开准确位置。

打包后的 macOS 常见路径：

```text
~/Library/Application Support/PRTS/
```

打包后的 Windows 常见路径：

```text
%APPDATA%\PRTS\
```

开发模式下 Electron 可能使用开发专用的 `userData` 路径；以
`Reveal data folder` 打开的目录为准。

主要文件：

| 文件 | 用途 |
| --- | --- |
| `settings.json` | 应用设置：当前后端、聊天工作目录、agent mode、技能（放音乐/搜索/打开网址·应用）、自动截图设置、外观（system / light / dark）、popover 尺寸。 |
| `conversation.json` | 当前可见聊天 session、Claude/Codex 各自的 resume session id、长期记忆 dormant 状态。 |
| `memory/MEMORY.md` | 精选长期记忆：博士的偏好、项目、反复出现的话题和值得记住的事实。 |
| `memory/CONVERSATION_SUMMARY.md` | 有界滚动摘要，用来在长对话时恢复较早上下文。 |
| `memory/CONVERSATION_ARCHIVE.jsonl` | Claude Code 和 Codex 共享的完整 user/assistant 对话档案，约 5 MB 上限，超过后从最旧记录开始裁剪。 |

记忆系统不会主动写入：

- 当前 repo。
- 用户选择的聊天工作目录。
- 项目文件本身，除非用户明确要求她改文件，或开启 agent mode 后交给她
  需要操作文件的任务。

Claude Code 和 Codex 自己仍会把登录状态、CLI session 等写在各自的目录，
比如 `~/.claude` 或 `~/.codex`。这个应用不会合并或改写这些官方 CLI
自己的存储。

## 记忆策略

Claude Code 和 Codex 共享同一套应用层记忆。两者的原生 resume session id
仍然分开保存，因为两个 CLI 的底层 session 不能互通；但应用会提供共享的
外层上下文：

- 同一份普瑞赛斯 persona prompt。
- 同一份 `MEMORY.md`。
- 同一份滚动对话摘要。
- 同一份有上限的 JSONL 对话档案。
- 同一份当前 UI 聊天历史。

当前 session 内的连续性比较轻量：最近可见的 user/assistant 对话会直接传给
当前使用的后端。

长期记忆会尽量克制：

- `MEMORY.md` 只存耐久事实，不存完整流水账。
- `CONVERSATION_SUMMARY.md` 有长度上限，避免 prompt 变慢。
- `CONVERSATION_ARCHIVE.jsonl` 约 5 MB 上限，过大时从最旧记录裁剪。
- 点击 `Clear conversation` 后，只清空当前可见聊天和两个后端的 resume id；
  `MEMORY.md`、`CONVERSATION_SUMMARY.md`、
  `CONVERSATION_ARCHIVE.jsonl` 都会保留。
- 清空后，长期记忆进入 dormant 模式。新的对话不会主动注入旧记忆，除非用户
  主动要求回忆，或提到「记得」「记忆」「上次」「之前」「以前」「我们聊过」
  「你还记得」等线索。

这样普通新 session 会比较省 token 和响应时间；但当用户真的要求回忆时，
Claude Code 和 Codex 都能读取同一份历史。

## 关键源码文件

| 文件 | 作用 |
| --- | --- |
| `src/main/persona.js` | 构造普瑞赛斯 / Priestess 的人格 prompt，定义 memory 文件路径，并控制长期记忆何时注入。 |
| `src/main/chat.js` | 探测本地 Claude/Codex CLI，选择当前后端，启动子进程，解析流式输出，持久化 archive/summary，并在两个后端之间共享上下文。 |
| `src/main/main.js` | Electron 主进程：菜单栏图标、右键菜单、后端菜单、设置持久化、聊天持久化、应用生命周期。 |
| `src/main/settings.js` | 默认设置和 `settings.json` 持久化。 |
| `src/main/preload.js` | Electron 主进程与 renderer 之间的安全 IPC 桥。 |
| `src/renderer/renderer.js` | Popover UI、聊天渲染、角色动画、点击/待机/表情逻辑、当前后端显示。 |
| `assets/character/` | 角色表情 PNG 素材目录。 |

## 角色素材

renderer 需要这些文件存在于 `assets/character`：

- `睁眼.png`, `半眯眼.png`, `快闭眼.png`, `闭眼.png`
- `笑.png`, `生气.png`, `威胁.png`, `哭唧唧.png`, `睡觉.png`
- `icon.png`，用于居中的菜单栏头像

PNG 文件不会被修改。renderer 会在运行时对边缘连通的白色背景做透明处理，
让角色干净地显示在 popover 面板上。

## 说明

这个仓库不内置第三方版权美术。角色图像请在权利方条款和画师授权范围内使用。
