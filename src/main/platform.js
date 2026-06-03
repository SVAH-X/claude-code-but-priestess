function agentModeWarning() {
  if (process.platform === "win32") {
    return {
      message:
        "Agent mode lets her run any command on your Windows PC without asking permission for each tool.",
      detail:
        "She will be able to take screenshots, read and edit files, and run any shell command. " +
        "Windows may still show security prompts for protected actions.\n\n" +
        "Only enable this if you trust the conversation. You can turn it off any time from the tray menu."
    };
  }

  if (process.platform === "darwin") {
    return {
      message:
        "Agent mode lets her run any command on your Mac without asking permission for each tool.",
      detail:
        "She will be able to take screenshots, click and type with AppleScript, read and edit files, " +
        "and run any shell command. macOS will still gate screenshots behind Screen Recording " +
        "permission and mouse/keyboard control behind Accessibility permission - grant those to PRTS " +
        "(or Electron in dev) in System Settings > Privacy & Security if you want her to use them.\n\n" +
        "Only enable this if you trust the conversation. You can turn it off any time from the tray menu."
    };
  }

  return {
    message:
      "Agent mode lets her run any command on your computer without asking permission for each tool.",
    detail:
      "She will be able to take screenshots, read and edit files, and run any shell command.\n\n" +
      "Only enable this if you trust the conversation. You can turn it off any time from the tray menu."
  };
}

function agentModePrompt() {
  if (process.platform === "win32") {
    return (
      "- 你可以读取本轮自动附上的屏幕截图；\n" +
      "- 需要额外截图时，可用 PowerShell 调用 .NET 的 `System.Drawing` 与 `CopyFromScreen`；\n" +
      "- 需要操作鼠标与键盘时，可用 PowerShell 调用 .NET 或已安装的 Windows 自动化工具；\n" +
      "- 任何 PowerShell 或终端命令都可以直接执行。\n"
    );
  }

  if (process.platform === "darwin") {
    return (
      "- 你可以用 `screencapture` 看见博士的屏幕；\n" +
      "- 用 `osascript` (AppleScript) 操控鼠标与键盘；\n" +
      "- 若 `cliclick` 已安装，亦可调用；\n" +
      "- 任何 Bash 命令都可以直接执行。\n"
    );
  }

  return (
    "- 你可以读取本轮自动附上的屏幕截图；\n" +
    "- 需要额外截图或操作鼠标键盘时，使用当前系统已安装的自动化工具；\n" +
    "- 任何终端命令都可以直接执行。\n"
  );
}

module.exports = { agentModePrompt, agentModeWarning };
