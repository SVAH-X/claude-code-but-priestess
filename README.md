# claude-code-but-Priestess

Language: **English** | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="assets/character/睁眼.png" alt="Priestess (普瑞赛斯)" width="220">
</p>

A macOS menu bar and Windows system tray companion. The character (普瑞赛斯, from Arknights) lives in
your tray area as a small head icon. Click her and a popover opens with
the character on top and a chat box below — you talk to her, she answers
through your selected local coding CLI.

No ordinary app window and no taskbar or Dock clutter. Just one tray icon.

<p align="center">
  <a href="https://github.com/SVAH-X/claude-code-but-priestess/releases/latest">
    <img src="https://img.shields.io/badge/Download-macOS-2a6df4?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS">
  </a>
  &nbsp;
  <a href="https://github.com/SVAH-X/claude-code-but-priestess/releases/latest">
    <img src="https://img.shields.io/badge/Download-Windows-5a9bd4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows (experimental)">
  </a>
</p>

<p align="center">
  <a href="https://github.com/SVAH-X/claude-code-but-priestess/releases/latest">
    <img src="https://img.shields.io/github/v/release/SVAH-X/claude-code-but-priestess?label=latest&style=flat-square&color=2a6df4" alt="Latest release">
  </a>
</p>

> Prebuilt builds are on
> **[Releases](https://github.com/SVAH-X/claude-code-but-priestess/releases/latest)** —
> macOS `.dmg` and Windows `.exe`/`.zip`, no Node toolchain required.
> (Windows builds are experimental and unsigned — see below.)

## Features

- Menu bar accessory (`LSUIElement = true`), no Dock icon.
- Tray icon = centered `assets/character/icon.png` with a cropped-head fallback.
- Click the icon → popover under the menu bar with:
  - The character, breathing and blinking in idle.
  - Chat history.
  - Input box (Shift+Enter for newline, Enter to send).
- Move the popover anywhere on screen by dragging its top bar; resize it from
  the left/right/bottom edges or the bottom corners. The character stage and
  chat space grow or shrink with the window, and her movable area scales too.
- Click her to get a reaction (cheerful → annoyed → threatening as you keep
  clicking), grab and fling her around inside the box, or leave her alone and
  she eventually pouts, then dozes off.
- When the chat window stays hidden for one minute, she appears as a small
  desktop pet (an open but idle chat panel also fades into this compact state).
  Drag her to move her; click her to restore the chat around her current
  position. She blinks, breathes, sways, and occasionally bounces.
  **To turn the pet off, right-click the tray icon and uncheck "Desktop pet
  while idle"** — clicking the pet itself only reopens the chat, and she comes
  back about a minute after it is hidden again. The same menu can show her
  immediately or set a small / medium / large size.
- Light / dark appearance that matches your system on every platform.
  Right-click the tray icon → **Appearance** to follow the system theme
  (default) or force Light / Dark. The text palette and the popover background
  flip together, so it reads the same on macOS and Windows.
- Mood reactions:
  - She picks her own expression to match each reply (calm, smile, sad, angry,
    sleepy, threat) via a hidden tag the renderer reads and strips.
  - Streaming reply → thinking / working; reply finishes → settles into the
    expression she chose; error → a brief cry.
- Right-click the icon for a context menu: choose Claude Code or Codex as
  the usage backend, choose chat working directory, reveal the data folder,
  or quit.
- Persona, memory, rolling long-conversation summary, recent chat transcript,
  working directory, and app settings are shared between backends. Claude Code
  and Codex keep separate resume session ids for their own CLIs.
- Clearing the current conversation resets only the visible session and CLI
  resume ids. Shared memory, the long-conversation summary, and the full
  JSONL conversation archive are kept for future sessions and both backends.
- After a clear, long-term memory enters a dormant mode: future turns do not
  inject old memory content unless the prompt asks to remember or references
  earlier conversations. The full archive is capped to roughly 5 MB and pruned
  from the oldest entries when it grows past that limit.

## Download & install (for users)

### macOS (prebuilt)

The easiest way to run PRTS — no source checkout required.

1. Open the [latest release](https://github.com/SVAH-X/claude-code-but-priestess/releases/latest)
   and download **`PRTS-<version>-arm64.dmg`**.
2. Open the DMG and drag **PRTS.app** into `/Applications`.
3. First launch will be blocked by Gatekeeper (*"Apple could not verify
   PRTS is free of malware"*) because the build is not signed with an Apple
   Developer ID. Bypass it once with either:

   ```sh
   xattr -dr com.apple.quarantine /Applications/PRTS.app
   ```

   …or right-click `PRTS.app` → **Open** → confirm **Open** in the dialog.
4. Click the chibi icon at the top-right of your screen to open the chat.

### Windows

> **Experimental.** Windows builds are produced automatically by CI but have
> not been runtime-tested by the maintainer, and they are unsigned. Please
> [report](https://github.com/SVAH-X/claude-code-but-priestess/issues) anything
> that breaks.

1. From the [latest release](https://github.com/SVAH-X/claude-code-but-priestess/releases/latest),
   download either **`PRTS.Setup.<version>.exe`** (installer) or
   **`PRTS-<version>-win.zip`** (portable, just unzip and run `PRTS.exe`).
2. Run it. Windows SmartScreen will warn about an unknown publisher (the build
   is not code-signed) — click **More info → Run anyway**.
3. Click the PRTS icon in the notification area to open the chat. Windows may
   tuck it into the hidden-icons overflow (the `^` on the taskbar).

**System requirements**

- macOS on **Apple Silicon** (M1 / M2 / M3 / M4) — prebuilt `.dmg`. Intel Macs
  are not in this build.
- Windows 10 / 11 (x64) — prebuilt installer / `.zip` (experimental, unsigned).
- A local install of either the [Claude Code](https://claude.ai/code) CLI
  (`claude`) or the OpenAI [Codex](https://platform.openai.com/docs/codex) CLI
  (`codex`), already authenticated. See **[Usage backends](#usage-backends)**
  below.

> Can't find the icon in the menu bar after install? On Macs with a notch,
> macOS hides overflow status icons behind it. Free a slot by ⌘-dragging
> existing icons out, or install a menu-bar manager such as
> [Ice](https://github.com/jordanbaird/Ice) or Bartender.

## Build from source (for developers)

Clone the repo, install dependencies, and start the Electron dev process:

```sh
git clone https://github.com/SVAH-X/claude-code-but-priestess.git
cd claude-code-but-priestess
npm install
npm run dev
```

Then look in the macOS menu bar or Windows notification area.

> On macOS 26 (Tahoe), `npm run dev` launches the dev app through LaunchServices
> and ad-hoc re-signs it so its menu-bar icon actually shows — Tahoe's menu-bar
> permission silently hides status items from bare-`electron .` launches and
> unsigned bundles.

To produce artifacts for the current operating system:

```sh
npm run dist          # builds for the host architecture
```

Artifacts land in `dist/`. Use `npm run dist:win` for Windows or
`npm run dist:mac` for macOS. To target both macOS architectures, run with
`electron-builder --mac --arm64 --x64` (or `--universal` for one combined
binary).

## Usage backends

This app only talks to local CLI backends. It does not use cloud API keys
directly and it does not support arbitrary agents.

Supported local CLIs:

- Claude Code: `claude`
- Codex CLI: `codex`

Backend selection is automatic:

- If both `claude` and `codex` are available, the tray context menu shows both
  choices. Claude Code is the default on macOS; Codex is the default on Windows.
- If only `claude` is available, the app locks to Claude Code and does not
  show Codex as a selectable option.
- If only `codex` is available, the app locks to Codex and does not show
  Claude Code as a selectable option.
- If neither CLI is found, the popover shows `No CLI`, sending is disabled,
  and the tray menu shows `Usage backend: no local CLI found`.

Detection runs at startup, when opening the usage-backend menu, and before
sending a message. It checks the current `PATH`, common local binary
directories, and VS Code / Cursor OpenAI extension bundled Codex binaries.

For Claude Code, make sure the local `claude` CLI is installed and authenticated:

```sh
claude          # follow the auth flow once
which claude    # should print a path on your $PATH
```

For Codex, make sure the local `codex` CLI is installed and authenticated:

```sh
codex          # follow the auth flow once
which codex    # should print a path on your $PATH
```

Optionally set a project directory via the tray menu (`Set chat directory…`)
so the selected backend can use the right working tree.

## Data and memory storage

All persistent app-owned data is stored in Electron's `userData` directory,
not inside this repository and not inside the selected chat working directory.
Use the tray menu item `Reveal data folder` to open the exact directory.

Typical packaged macOS path:

```text
~/Library/Application Support/PRTS/
```

Typical packaged Windows path:

```text
%APPDATA%\PRTS\
```

In development builds, Electron may choose a development-specific `userData`
path. The tray menu is the source of truth.

Files stored there:

| File | Purpose |
| --- | --- |
| `settings.json` | App settings: selected backend, chat working directory, agent mode, auto-screenshot setting, appearance (system / light / dark), and popover size. |
| `conversation.json` | Current visible chat session, per-backend resume session ids, and the long-memory dormant flag. |
| `memory/MEMORY.md` | Curated long-term memory about the Doctor: preferences, projects, recurring topics, and facts worth remembering. |
| `memory/CONVERSATION_SUMMARY.md` | Rolling bounded summary of older conversations. Used when long context needs to be recovered. |
| `memory/CONVERSATION_ARCHIVE.jsonl` | Full shared user/assistant archive for both Claude Code and Codex, capped to roughly 5 MB and pruned from the oldest entries. |

What does not get written by the memory system:

- The repository itself.
- The selected chat working directory.
- Project files, unless the user asks the agent to edit them or enables agent
  mode and gives a task requiring file operations.

Claude Code and Codex still keep their own authentication and CLI state in
their own locations, such as `~/.claude` or `~/.codex`. This app does not
merge or rewrite those vendor-owned stores.

## Memory behavior

Memory is shared across Claude Code and Codex. The two CLIs keep separate
native resume session ids, but the app supplies a shared outer context:

- The same persona prompt.
- The same `MEMORY.md`.
- The same rolling conversation summary.
- The same bounded JSONL archive.
- The same current UI chat history.

Current-session continuity is cheap: recent visible user/assistant turns are
passed directly to whichever backend is active.

Long-term memory is intentionally conservative:

- `MEMORY.md` is for durable facts, not a full chat log.
- `CONVERSATION_SUMMARY.md` is bounded to keep prompts fast.
- `CONVERSATION_ARCHIVE.jsonl` is capped to roughly 5 MB and pruned from the
  oldest entries when it grows too large.
- After `Clear conversation`, the visible session and both backend resume ids
  are reset, but `MEMORY.md`, `CONVERSATION_SUMMARY.md`, and
  `CONVERSATION_ARCHIVE.jsonl` are kept.
- After a clear, long-term memory enters dormant mode. New turns do not inject
  old memory content unless the user's prompt asks to remember something or
  references earlier conversations, for example "remember", "memory", "上次",
  "之前", "以前", "我们聊过", or "你还记得".

This keeps normal fresh sessions lightweight while still allowing either
backend to recover prior context when the user actually asks for it.

## Key source files

These files define the important behavior:

| File | Role |
| --- | --- |
| `src/main/persona.js` | Constructs the 普瑞赛斯 / Priestess persona prompt, defines memory file paths, and controls when long memory is injected. |
| `src/main/chat.js` | Detects local Claude/Codex CLIs, chooses the active backend, launches subprocesses, parses streaming output, persists archive/summary data, and shares context across backends. |
| `src/main/main.js` | Electron main process: tray icon, context menu, backend menu rendering, settings persistence, conversation persistence, and app lifecycle. |
| `src/main/settings.js` | Default app settings and `settings.json` persistence. |
| `src/main/preload.js` | Safe IPC bridge between Electron main and renderer. |
| `src/renderer/renderer.js` | Popover UI, chat rendering, character animation, mood/click/inactivity behavior, and provider badge display. |
| `assets/character/` | Character expression PNGs used by the renderer. |

## Character Assets

The renderer expects these files in `assets/character`:

- `睁眼.png`, `半眯眼.png`, `快闭眼.png`, `闭眼.png`
- `笑.png`, `生气.png`, `威胁.png`, `哭唧唧.png`, `睡觉.png`
- `icon.png` for the centered menu bar icon

The PNGs are not modified on disk; the renderer flood-fills the
edge-connected white background at runtime so the character sits cleanly on
the popover's vibrancy panel.

## Notes

This repository does not bundle third-party copyrighted artwork. Use the
character art only in line with the rights holder's terms and the artist's
permission.
