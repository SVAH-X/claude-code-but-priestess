import * as vscode from "vscode";
import { WsClient } from "./src/ws-client";
import { ChatPanelProvider } from "./src/chat-panel";
import { ContextCapture } from "./src/context-capture";

let wsClient: WsClient | null = null;
let contextCapture: ContextCapture | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log("PRTS: activating…");

  wsClient = new WsClient(context);

  // Vibe coding: capture editor context, diagnostics, workspace, activity
  contextCapture = new ContextCapture(wsClient, context);
  context.subscriptions.push(contextCapture);

  const chatProvider = new ChatPanelProvider(context, wsClient, contextCapture);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("prts.chatView", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ---- Commands ----

  context.subscriptions.push(
    vscode.commands.registerCommand("prts.openChat", () => {
      vscode.commands.executeCommand("workbench.view.extension.prts-sidebar");
    })
  );

  // Vibe coding: send selection to Priestess
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("PRTS: No active editor.");
        return;
      }
      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage("PRTS: Select some code first.");
        return;
      }
      const text = editor.document.getText(selection);
      const ctx = contextCapture?.getCurrentContext();
      if (wsClient && wsClient.isConnected()) {
        wsClient.send("vscode:selection-to-chat", { text, context: ctx });
        vscode.commands.executeCommand("workbench.view.extension.prts-sidebar");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("prts.newConversation", () => {
      if (wsClient && wsClient.isConnected()) {
        wsClient.send("conversation:new");
        vscode.window.showInformationMessage("PRTS: started a new conversation");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("prts.restoreConversation", () => {
      if (wsClient && wsClient.isConnected()) {
        wsClient.send("conversation:restore");
        vscode.window.showInformationMessage("PRTS: restored previous conversation");
      }
    })
  );

  // Vibe coding: cycle through companion → advisor → agent
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.toggleVibeCoding", async () => {
      if (!wsClient || !wsClient.isConnected()) return;
      try {
        const res: any = await wsClient.send("settings:get");
        const state = res?.state || {};
        const current = state.vibeCodingMode || "companion";
        const next = current === "companion" ? "advisor"
                   : current === "advisor" ? "agent"
                   : "companion";
        // Require confirmation when switching to agent mode
        if (next === "agent") {
          const choice = await vscode.window.showWarningMessage(
            "切换至代理模式将授予普瑞赛斯完整的终端权限——她可以读取、编辑文件，运行任意命令。",
            { modal: true },
            "确认切换",
            "取消"
          );
          if (choice !== "确认切换") return;
        }
        await wsClient.send("settings:set", { patch: { vibeCodingMode: next } });
        const labels: Record<string, string> = {
          companion: "💬 陪伴模式（仅聊天）",
          advisor: "👁 顾问模式（只读工具）",
          agent: "⚡ 代理模式（完整权限）",
        };
        vscode.window.showInformationMessage(`PRTS: ${labels[next]}`);
      } catch (_) { /* ignore */ }
    })
  );

  // Vibe coding: show current editor context info
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.showContextInfo", () => {
      const ctx = contextCapture?.getCurrentContext();
      if (!ctx?.activeFile) {
        vscode.window.showInformationMessage("PRTS: No active editor.");
        return;
      }
      const file = ctx.activeFile.split(/[\\/]/).pop();
      const lines: string[] = [
        `📄 ${file}`,
        `   语言: ${ctx.activeFileLanguage || "unknown"}`,
        `   光标: L${ctx.cursorLine}:${ctx.cursorColumn}`,
      ];
      if (ctx.selection) {
        lines.push(`   已选中: L${ctx.selection.startLine}-${ctx.selection.endLine} (${ctx.selection.text.length} 字符)`);
      }
      const diag = contextCapture?.getDiagnostics();
      if (diag && diag.errors > 0) {
        lines.push(`   ⚠ 诊断: ${diag.errors} 错误, ${diag.warnings} 警告`);
      }
      vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
    })
  );

  // ---- Window focus tracking ----

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (wsClient && wsClient.isConnected()) {
        wsClient.send("vscode:focus", { focused: state.focused });
      }
    })
  );

  // ---- Connection lifecycle ----

  // On first connect: send vscode:active, offer to restore previous conversation
  wsClient.on("connected", () => {
    wsClient!.send("vscode:active");
  });

  // After auth, the server sends conversation:has-previous
  wsClient.on("conversation:has-previous", (msg: any) => {
    if (msg.hasPrevious) {
      vscode.window
        .showInformationMessage(
          "PRTS: You have a previous conversation. Restore it?",
          "Restore",
          "Start Fresh"
        )
        .then((choice) => {
          if (choice === "Restore") {
            wsClient!.send("conversation:restore");
          } else if (choice === "Start Fresh") {
            wsClient!.send("conversation:new");
          }
        });
    }
  });

  console.log("PRTS: activated");
}

export function deactivate() {
  if (contextCapture) {
    contextCapture.dispose();
    contextCapture = null;
  }
  if (wsClient) {
    wsClient.dispose();
    wsClient = null;
  }
}
