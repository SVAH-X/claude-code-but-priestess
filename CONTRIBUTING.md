# 贡献指南 / Contributing

这是一个个人项目，维护者只有一个人，在 macOS 上开发。欢迎 issue 和 PR，但请先看一眼下面几条——它们决定了一个 PR 会被认真读，还是被直接关掉。

This is a one-person project, maintained on macOS. Issues and pull requests are welcome, but please read the rules below — they decide whether a PR gets read carefully or closed on sight.

---

## 不接受的 PR / What gets closed

**自动生成的依赖升级 / 「安全修复」PR。** 包括扫描器（trivy、Snyk、各类 AI security 产品）批量产出的版本号 bump。依赖升级由 Dependabot 处理，不需要外部 PR。这类 PR 会被直接关闭。

**带推广内容的 PR。** 正文、commit message、分支名里出现产品名、服务链接或署名广告的，一律关闭并拉黑。

**模板化的 PR 描述。** 如果正文里的话（"tightens handling of untrusted input"、"removes an exploit primitive" 之类）跟实际改动对不上，说明没人读过这个 diff，我也不会读。

**顺手的重新格式化。** 不要重新序列化 `package.json`、不要改动无关行的缩进、不要把中文转成 `\uXXXX` 转义。diff 里的每一行都应该是你有意改的。

---

**Automated dependency / "security fix" PRs.** Including bulk version bumps produced by scanners (trivy, Snyk, AI security products). Dependency updates are handled by Dependabot; outside PRs are not needed and will be closed.

**PRs carrying promotional content.** Any product name, service link, or vendor byline in the body, commit message, or branch name gets the PR closed and the account blocked.

**Templated descriptions.** If the prose ("tightens handling of untrusted input", "removes an exploit primitive") does not describe the actual change, nobody read the diff — and neither will I.

**Drive-by reformatting.** Do not re-serialize `package.json`, reindent unrelated lines, or escape CJK text to `\uXXXX`. Every line in the diff should be one you meant to change.

## 安全问题 / Security

请通过 GitHub 的 [Security advisory](https://github.com/SVAH-X/claude-code-but-priestess/security/advisories/new) 私下报告，不要开公开的 PR 或 issue。

Report privately through GitHub's [Security advisory](https://github.com/SVAH-X/claude-code-but-priestess/security/advisories/new) form — not as a public PR or issue.

## 欢迎的 PR / What is welcome

- 有明确复现步骤的 bug 修复
- Windows / Linux 上的平台适配（我只能在 macOS 上验证，所以请说明你实际测过什么）
- 文档修正

- Bug fixes with clear reproduction steps
- Windows / Linux platform fixes (I can only verify on macOS, so say what you actually tested)
- Documentation corrections

## 提 PR 之前 / Before opening a PR

```bash
npm test
npm run lint
```

两个都要过。另外：

- **一个 PR 一件事。** 顺带修的东西请单独开。
- **说明你测过什么。** 「应该没问题」不算。平台相关的改动请写明系统版本和实际操作过程。
- **别改 `package.json` 的元信息**（name、description、version）除非那就是 PR 的目的。
- 大改动（新功能、新的原生依赖、新的外部服务）请先开 issue 聊一下，别直接写完 800 行再来。

Both must pass. Also:

- **One PR, one thing.** Split out anything you fixed along the way.
- **Say what you tested.** "Should work" does not count. For platform-specific changes, give the OS version and what you actually did.
- **Don't touch `package.json` metadata** (name, description, version) unless that is the point of the PR.
- For anything large (a new feature, a new native dependency, a new external service), open an issue first rather than arriving with 800 lines.

## 许可 / License

本项目使用 [PolyForm Noncommercial 1.0.0](LICENSE)。提交 PR 即表示你同意你的贡献以相同许可发布。

This project is under [PolyForm Noncommercial 1.0.0](LICENSE). By opening a PR you agree to license your contribution under the same terms.
