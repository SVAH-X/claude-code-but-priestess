import * as vscode from "vscode";
import { WsClient } from "./src/ws-client";
import { ChatPanelProvider } from "./src/chat-panel";
import { ContextCapture } from "./src/context-capture";
import { InlineCompletionProvider } from "./src/inline-provider";
import { buildRecentChangesSummary } from "./src/git-summary";

let wsClient: WsClient | null = null;
let contextCapture: ContextCapture | null = null;
let chatProvider: ChatPanelProvider | null = null;

/**
 * Returns true when the PRTS tray app is connected. When it is not, warns
 * the user - commands that previously no-op'd silently now give feedback
 * instead of looking broken.
 */
function requireConnected(): boolean {
  if (wsClient && wsClient.isConnected()) return true;
  vscode.window.showWarningMessage("PRTS: 未连接到托盘应用。");
  return false;
}

/**
 * Sends a user message to the PRTS chat through the WS bridge and opens the
 * sidebar. Commands that previously inlined this triple (connection check,
 * notify, open sidebar) now share one path.
 */
function sendToChat(text: string, context: any): boolean {
  if (!requireConnected()) return false;
  wsClient!.notify("vscode:selection-to-chat", { text, context: context || null });
  vscode.commands.executeCommand("workbench.view.extension.prts-sidebar");
  return true;
}

export function activate(context: vscode.ExtensionContext) {
  console.log("PRTS: activating…");

  wsClient = new WsClient(context);

  // Vibe coding: capture editor context, diagnostics, workspace, activity
  contextCapture = new ContextCapture(wsClient);
  context.subscriptions.push(contextCapture);

  chatProvider = new ChatPanelProvider(context, wsClient, contextCapture);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("prts.chatView", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Inline completion provider (ghost text) — registered for all languages.
  const inlineProvider = new InlineCompletionProvider(wsClient);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" }, inlineProvider
    )
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
      sendToChat(text, ctx);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("prts.newConversation", () => {
      if (!requireConnected()) return;
      wsClient!.notify("conversation:new");
      vscode.window.showInformationMessage("PRTS: started a new conversation");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("prts.restoreConversation", () => {
      if (!requireConnected()) return;
      wsClient!.notify("conversation:restore");
      vscode.window.showInformationMessage("PRTS: restored previous conversation");
    })
  );

  // Vibe coding: toggle companion ↔ advisor (VS Code extension doesn't need full agent)
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.toggleVibeCoding", async () => {
      if (!wsClient || !wsClient.isConnected()) return;
      try {
        const res: any = await wsClient.request("settings:get");
        const state = res?.state || {};
        const current = state.vibeCodingMode || "companion";
        // Only companion and advisor — agent is the tray app's domain.
        const next = current === "companion" ? "advisor" : "companion";
        await wsClient.request("settings:set", { patch: { vibeCodingMode: next } });
        const labels: Record<string, string> = {
          companion: "💬 陪伴模式（仅聊天）",
          advisor: "👁 顾问模式（只读工具）",
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

  // Vibe coding: suggest a fix for the selected code / current line
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.suggestFix", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("PRTS: No active editor.");
        return;
      }
      const doc = editor.document;
      const sel = editor.selection;
      // Use selection if non-empty, otherwise the current line.
      const range = sel.isEmpty
        ? doc.lineAt(sel.active.line).range
        : sel;
      const code = doc.getText(range);
      const file = doc.fileName.split(/[\\/]/).pop();
      const line = range.start.line + 1;
      const lang = doc.languageId;

      // Find diagnostics at this location
      const diags = vscode.languages.getDiagnostics(doc.uri)
        .filter((d) => d.range.intersection(range));
      const diagLines = diags.length
        ? diags.map((d) => `  - [${d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"}] L${d.range.start.line + 1}: ${d.message}`).join("\n")
        : "";

      const prompt =
        `【博士的修复请求】\n` +
        `- 文件: ${file} (${lang})\n` +
        `- 位置: 第 ${line} 行\n` +
        (diagLines ? `- 诊断:\n${diagLines}\n` : "") +
        `\n博士选中的代码:\n\`\`\`${lang}\n${code}\n\`\`\`\n` +
        `\n请分析这段代码的问题并给出修复方案。用代码块展示修改后的完整代码。`;

      sendToChat(prompt, contextCapture?.getCurrentContext());
    })
  );

  // Vibe coding: explain the error at cursor position
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.explainError", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("PRTS: No active editor.");
        return;
      }
      const doc = editor.document;
      const pos = editor.selection.active;
      const line = doc.lineAt(pos.line);
      const file = doc.fileName.split(/[\\/]/).pop();
      const lang = doc.languageId;

      // Find diagnostics at cursor position
      const diags = vscode.languages.getDiagnostics(doc.uri)
        .filter((d) => d.range.contains(pos));
      const diagText = diags.length
        ? diags.map((d) => `[${d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"}] ${d.message}`).join("\n")
        : "(no diagnostic at cursor — using the current line for context)";

      const code = line.text.trim() || "(empty line)";
      const prompt =
        `【博士的提问 — 解释错误】\n` +
        `- 文件: ${file} (${lang})\n` +
        `- 位置: 第 ${pos.line + 1} 行\n` +
        `- 诊断:\n${diagText}\n` +
        `- 该行代码:\n\`\`\`${lang}\n${code}\n\`\`\`\n` +
        `\n请解释这个错误的原因，并给出具体的修复方案。`;

      sendToChat(prompt, contextCapture?.getCurrentContext());
    })
  );

  // Vibe coding: review the current file
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.reviewFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("PRTS: No active editor.");
        return;
      }
      const doc = editor.document;
      const file = doc.fileName.split(/[\\/]/).pop();
      const lang = doc.languageId;
      const text = doc.getText();
      // Truncate very large files
      const MAX_LEN = 80_000;
      const truncated = text.length > MAX_LEN
        ? text.slice(0, MAX_LEN) + `\n…(文件共 ${text.length} 字符，已截断前 ${MAX_LEN} 字符)`
        : text;

      const prompt =
        `【博士的请求 — 审查文件】\n` +
        `- 文件: ${file} (${lang})\n` +
        `- 共 ${doc.lineCount} 行，${text.length} 字符\n` +
        `\n请审查这个文件，找出潜在的问题、代码异味、安全隐患和改进建议。\n` +
        `\n\`\`\`${lang}\n${truncated}\n\`\`\``;

      sendToChat(prompt, contextCapture?.getCurrentContext());
    })
  );

  // Vibe coding: summarize recent git changes
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.summarizeChanges", async () => {
      try {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length) {
          vscode.window.showWarningMessage("PRTS: No workspace folder open.");
          return;
        }
        const cwd = folders[0].uri.fsPath;
        // Async git collection (execFile-based). execSync would block the
        // extension host event loop and freeze the VS Code UI for up to the
        // timeout while git runs.
        const gitInfo = await buildRecentChangesSummary(cwd);

        const prompt =
          `【博士的请求 — 总结近期改动】\n` +
          `${gitInfo}\n` +
          `\n请用简洁的语言总结最近的代码改动，指出潜在的风险区域。`;

        sendToChat(prompt, contextCapture?.getCurrentContext());
      } catch (err) {
        vscode.window.showErrorMessage("PRTS: Failed to summarize changes — " + (err as Error).message);
      }
    })
  );

  // Vibe coding: generate tests for selected code
  context.subscriptions.push(
    vscode.commands.registerCommand("prts.generateTests", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("PRTS: No active editor.");
        return;
      }
      const doc = editor.document;
      const sel = editor.selection;
      const range = sel.isEmpty
        ? new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
        : sel;
      const code = doc.getText(range);
      const file = doc.fileName.split(/[\\/]/).pop();
      const lang = doc.languageId;
      // Truncate very large selections
      const MAX_SEL = 20_000;
      const truncated = code.length > MAX_SEL
        ? code.slice(0, MAX_SEL) + `\n…(选中代码共 ${code.length} 字符，已截断)`
        : code;

      // Generate a test scenario prompt based on language
      const testLang = lang === "typescript" || lang === "javascript" ? "Jest" :
        lang === "python" ? "pytest" : lang === "java" ? "JUnit" : "单元测试";
      const prompt =
        `【博士的请求 — 生成测试】\n` +
        `- 文件: ${file} (${lang})\n` +
        `- 测试框架: ${testLang}\n` +
        (sel.isEmpty ? `- 范围: 整个文件 (${doc.lineCount} 行)\n` : `- 范围: L${range.start.line + 1}-L${range.end.line + 1}\n`) +
        `\n请为以下代码生成${testLang}测试，覆盖：\n` +
        `1. 正常路径（happy path）\n` +
        `2. 边界条件（null/undefined、空数组、极值）\n` +
        `3. 错误路径（异常处理）\n` +
        `\n用代码块展示测试代码。\n` +
        `\n\`\`\`${lang}\n${truncated}\n\`\`\``;

      sendToChat(prompt, contextCapture?.getCurrentContext());
    })
  );

  // ---- Window focus tracking ----

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (wsClient && wsClient.isConnected()) {
        wsClient.notify("vscode:focus", { focused: state.focused });
      }
    })
  );

  // ---- Connection lifecycle ----

  let autoSwitchedToAdvisor = false;

  // On first connect: send vscode:active, sync advisor blacklist from VS Code config,
  // and auto-switch to advisor mode if a workspace is open.
  (wsClient as any).on("connected", () => {
    wsClient!.notify("vscode:active");
    // Sync the advisor file blacklist from VS Code settings to Electron.
    const blacklist = vscode.workspace.getConfiguration("prts").get<string>("advisorFileBlacklist");
    if (typeof blacklist === "string") {
      // Fire-and-forget sync - a failing settings write is not worth an error
// dialog on every connect, so swallow the rejection explicitly.
wsClient!.request("settings:set", { patch: { advisorFileBlacklist: blacklist } }).catch(() => {});
    }
    // When a workspace is open, offer advisor mode once per session instead of
    // silently rewriting the user's persisted setting: advisor gives the model
    // read access to workspace context, so it should be an explicit choice.
    if (!autoSwitchedToAdvisor) {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        // Ask at most once per session; reconnects must not re-prompt.
        autoSwitchedToAdvisor = true;
        wsClient!.request("settings:get")
          .then((res: any) => {
            const mode = res?.state?.vibeCodingMode || "companion";
            // The user already picked a mode - do not nag.
            if (mode !== "companion") return;
            return vscode.window
              .showInformationMessage(
                "PRTS: 已打开工作区，是否切换到顾问模式（可让普瑞赛斯读取工作区上下文）？",
                "切换",
                "保持陪伴"
              )
              .then((choice) => {
                if (choice === "切换") {
                  return wsClient!.request("settings:set", { patch: { vibeCodingMode: "advisor" } });
                }
              });
          })
          .catch(() => {});
      }
    }
  });

  // After auth, the server sends conversation:has-previous.
  // Only prompt once per extension session — reconnects shouldn't re-ask.
  let hasPromptedRestore = false;

  (wsClient as any).on("conversation:has-previous", (msg: any) => {
    if (msg.hasPrevious && !hasPromptedRestore) {
      hasPromptedRestore = true;
      vscode.window
        .showInformationMessage(
          "PRTS: You have a previous conversation. Restore it?",
          "Restore",
          "Start Fresh"
        )
        .then((choice) => {
          if (choice === "Restore") {
            wsClient!.notify("conversation:restore");
          } else if (choice === "Start Fresh") {
            wsClient!.notify("conversation:new");
          }
        });
    }
  });

  console.log("PRTS: activated");
}

export function deactivate() {
  // Clean up temp preview files (fix diffs / HTML previews) first.
  if (chatProvider) {
    try { chatProvider.dispose(); } catch (_) { /* ignore */ }
    chatProvider = null;
  }
  if (contextCapture) {
    contextCapture.dispose();
    contextCapture = null;
  }
  if (wsClient) {
    wsClient.dispose();
    wsClient = null;
  }
}
