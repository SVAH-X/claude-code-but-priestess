const { test, equal, deepEqual, isTrue, isFalse } = require("./helper");
const blacklist = require("../src/main/file-blacklist");
const { claudeReadDenyRules, isBlacklisted, matchBlacklist, matchClaudeReadDeny, parseBlacklist } = blacklist;

const DEFAULTS = parseBlacklist(
  ".env\n.env.*\n*secret*\n*credential*\n*.pem\n*.key\nid_rsa*\n*password*\n*token*"
);
// Path styles only: matching behaves the same on every platform.
const mac = (root) => ({ root });
const win = (root) => ({ root });
const linux = (root) => ({ root });

test("parseBlacklist handles gitignore string with comments, blanks and CRLF", () => {
  const p = parseBlacklist("# comment\r\n.env\r\n\r\n*secret*\n*.pem\n# another\nid_rsa*");
  deepEqual(p, [".env", "*secret*", "*.pem", "id_rsa*"]);
});

test("parseBlacklist handles legacy array format", () => {
  deepEqual(parseBlacklist([".env", "  *.pem  ", "", null, "id_rsa*"]), [".env", "*.pem", "id_rsa*"]);
  deepEqual(parseBlacklist(undefined), []);
});

test("the per-prompt workspace walk is gone", () => {
  isFalse("findBlacklistedFiles" in blacklist, "no filesystem scan API left");
});

// B3 regressions: folders above the workspace no longer decide anything.
test("folders above the workspace root never match", () => {
  const root = "/Users/alice/code/design-tokens";
  equal(matchBlacklist("/Users/alice/code/design-tokens/docs/screenshot.png", DEFAULTS, mac(root)), null);
  equal(matchBlacklist("/Users/alice/code/design-tokens/src/index.ts", DEFAULTS, mac(root)), null);
  equal(
    matchBlacklist("C:\\Users\\alice\\code\\design-tokens\\docs\\screenshot.png", DEFAULTS, win("C:\\Users\\alice\\code\\design-tokens\\")),
    null
  );
});

test("files outside the root are judged by basename only", () => {
  const root = "/Users/alice/code/app";
  equal(matchBlacklist("/Users/alice/code/design-tokens/docs/screenshot.png", DEFAULTS, mac(root)), null);
  equal(matchBlacklist("/Users/alice/Desktop/Deck.keynote/preview.jpg", DEFAULTS, mac(root)), null, "*.key is anchored to the name end");
  equal(matchBlacklist("/Users/alice/Desktop/Deck.keynote/preview.jpg", DEFAULTS, mac("")), null, "no root: basename only");
  equal(matchBlacklist("/Users/alice/secrets/notes.txt", DEFAULTS, mac(root)), null, "an outside parent folder is not judged");
  equal(matchBlacklist("/Users/alice/.ssh/id_rsa", DEFAULTS, mac(root)), "id_rsa*");
});

test("gitignore semantics inside the root: a matching directory covers its contents", () => {
  const root = "/Users/alice/code";
  equal(matchBlacklist("/Users/alice/code/design-tokens/docs/screenshot.png", DEFAULTS, mac(root)), "*token*");
  equal(matchBlacklist("/Users/alice/code/app/src/tokenizer/diagram.png", DEFAULTS, mac("/Users/alice/code/app")), "*token*");
  equal(matchBlacklist("/Users/alice/code/app/.env", DEFAULTS, mac("/Users/alice/code/app")), ".env");
  equal(matchBlacklist("/Users/alice/code/app/config/.env.local", DEFAULTS, mac("/Users/alice/code/app")), ".env.*");
  equal(matchBlacklist("/Users/alice/code/app/src/main.ts", DEFAULTS, mac("/Users/alice/code/app")), null);
  equal(matchBlacklist("/Users/alice/code/app/src/environment.ts", DEFAULTS, mac("/Users/alice/code/app")), null);
});

test("matching ignores case on every platform (a deny list errs toward denying)", () => {
  const root = "/Users/alice/code/app";
  equal(matchBlacklist("/Users/alice/Desktop/Password Reset Flow.png", DEFAULTS, mac(root)), "*password*");
  equal(matchBlacklist("/home/alice/app/certs/Server.PEM", DEFAULTS, linux("/home/alice/app")), "*.pem");
  equal(matchBlacklist("/Users/alice/code/app/certs/Server.PEM", DEFAULTS, mac(root)), "*.pem");
  equal(matchBlacklist("/Users/Alice/Code/App/.ENV", DEFAULTS, mac("/users/alice/code/app")), ".env", "root prefix too");
});

test("Windows paths: separators, drive-letter case, UNC roots, other drives", () => {
  equal(matchBlacklist("C:\\Users\\alice\\code\\app\\.env", DEFAULTS, win("c:\\users\\ALICE\\code\\app")), ".env");
  equal(matchBlacklist("C:/Users/alice/code/app/config/Server.PEM", DEFAULTS, win("C:\\Users\\alice\\code\\app")), "*.pem");
  equal(matchBlacklist("C:\\Users\\alice\\code\\app\\src\\index.ts", DEFAULTS, win("C:\\Users\\alice\\code\\app")), null);
  equal(matchBlacklist("\\\\nas\\share\\proj\\.env.local", DEFAULTS, win("\\\\nas\\share\\proj")), ".env.*");
  equal(matchBlacklist("\\\\nas\\share\\tokens\\proj\\a.ts", DEFAULTS, win("\\\\nas\\share\\tokens\\proj")), null);
  equal(matchBlacklist("D:\\other\\notes.txt", DEFAULTS, win("C:\\proj")), null);
  equal(matchBlacklist("D:\\tokens\\notes.txt", DEFAULTS, win("C:\\proj")), null, "outside root: parent folder ignored");
  isTrue(isBlacklisted("C:\\proj\\keys\\deploy.key", DEFAULTS, win("C:\\proj\\")), "trailing separator on root");
  isFalse(isBlacklisted("C:\\proj", DEFAULTS, win("C:\\proj")), "the root itself is never blacklisted");
});

test("relative paths are taken as relative to the root", () => {
  equal(matchBlacklist("src/.env", DEFAULTS, linux("/x")), ".env");
  equal(matchBlacklist(".env", DEFAULTS, linux("")), ".env", "basename from an old extension");
  equal(matchBlacklist("../outside/tokens/a.txt", DEFAULTS, linux("/x")), null, "escaping the root: basename only");
});

test("anchored, directory-only and wildcard patterns", () => {
  const p = ["/config.json", "secrets/", "config/*.yml", "docs/**", "**/private/*.txt", "a\\b.txt", "[Tt]est?.key", "!keep.env", "# note"];
  const at = (file) => matchBlacklist(`/p/${file}`, p, linux("/p"));
  equal(at("config.json"), "/config.json");
  equal(at("sub/config.json"), null, "leading slash anchors to the root");
  equal(at("a/secrets/x.txt"), "secrets/");
  equal(at("secrets"), null, "trailing slash: directories only");
  equal(at("config/app.yml"), "config/*.yml");
  equal(at("x/config/app.yml"), null, "inner slash anchors to the root");
  equal(at("config/nested/app.yml"), null, "* does not cross directories");
  equal(at("docs/a/b.md"), "docs/**");
  equal(at("m/n/private/x.txt"), "**/private/*.txt");
  equal(at("private/x.txt"), "**/private/*.txt", "**/ matches zero directories");
  equal(at("a/b.txt"), "a\\b.txt", "backslash in a pattern is a separator");
  equal(at("Test1.key"), "[Tt]est?.key");
  equal(at("keep.env"), null, "negations are ignored, never inverted");
});

test("claudeReadDenyRules maps the list onto relative Read rules", () => {
  deepEqual(claudeReadDenyRules(DEFAULTS), [
    "Read(**/.env)",
    "Read(**/.env.*)",
    "Read(**/*secret*)",
    "Read(**/*credential*)",
    "Read(**/*.pem)",
    "Read(**/*.key)",
    "Read(**/id_rsa*)",
    "Read(**/*password*)",
    "Read(**/*token*)"
  ]);
  deepEqual(
    claudeReadDenyRules(["/config.json", "secrets/", "config/secrets/", "config/*.yml", "a\\b.txt", "!x", "# c", "report(1).txt", ".env", ".env"]),
    ["Read(**/config.json)", "Read(**/secrets/**)", "Read(config/secrets/**)", "Read(config/*.yml)", "Read(a/b.txt)", "Read(**/.env)"]
  );
  deepEqual(claudeReadDenyRules([]), []);
});

test("matchClaudeReadDeny mirrors what the emitted Read rules deny", () => {
  // Observed with Claude Code 2.1 on macOS: "Read(anchored.json)" also denied
  // sub/anchored.json, and outside-cwd files were never matched.
  const p = ["/anchored.json", "config/*.yml", "secrets/", "report(1).txt", "*.pem"];
  const at = (file, root = "/p") => matchClaudeReadDeny(file, p, linux(root));
  equal(at("/p/sub/anchored.json"), "anchored.json", "leading-slash names deny at any depth, like Claude");
  equal(matchBlacklist("/p/sub/anchored.json", p, linux("/p")), null, "while the blacklist itself anchors them");
  equal(at("/p/config/app.yml"), "config/*.yml");
  equal(at("/p/x/config/app.yml"), null);
  equal(at("/p/a/secrets/x.png"), "secrets/");
  equal(at("/p/report(1).txt"), null, "patterns Claude never receives never deny");
  equal(at("/elsewhere/cert.pem"), null, "outside the cwd the relative rules deny nothing");
  equal(at("cert.pem", ""), null, "no cwd, no rules to predict");
  equal(matchClaudeReadDeny("D:\\pics\\cert.pem", p, { root: "C:\\p", outsideRoot: "basename" }), "*.pem", "opt-in hedge by name");
  equal(matchBlacklist("/elsewhere/cert.pem", p, linux("/p")), "*.pem", "the blacklist still flags it by name");
  equal(matchBlacklist("/elsewhere/cert.pem", p, { root: "/p", outsideRoot: "ignore" }), null);
  equal(matchClaudeReadDeny("C:\\p\\Sub\\ANCHORED.JSON", p, win("c:\\P")), "anchored.json");
});

test("B3 paths from the review are not blacklisted by folders above the file", () => {
  // Tray cwd = the Doctor's home; the attachments live in ordinary folders.
  const home = "/Users/alice";
  const inProject = (file, root) => matchBlacklist(file, DEFAULTS, mac(root));
  equal(inProject("/Users/alice/code/design-tokens/docs/screenshot.png", "/Users/alice/code/design-tokens"), null);
  equal(inProject("/Users/alice/code/tokenizer/diagram.png", "/Users/alice/code/tokenizer"), null);
  equal(inProject("/Users/alice/Documents/Deck.keynote/preview.jpg", home), null);
  equal(inProject("/Users/alice/Desktop/cat.png", home), null);
  // Gitignore semantics still cover a matching name inside the root.
  equal(inProject("/Users/alice/Desktop/Password Reset Flow.png", home), "*password*");
});

test("SENSITIVE_FILE_PATTERNS blocks secrets on POSIX and Windows paths", () => {
  const { SENSITIVE_FILE_PATTERNS } = require("../src/main/file-blacklist");
  const denied = [
    "/proj/.env",
    "/proj/.env.local",
    "/proj/.envrc",
    "C:\\proj\\.env.production",
    "C:\\proj\\certs\\SERVER.PEM",
    "/home/doc/.ssh/id_ed25519",
    "C:\\Users\\Doc\\.ssh\\id_rsa",
    "/proj/prod.key",
    "/proj/cert.p12",
    "/home/doc/.npmrc",
    "/home/doc/.git-credentials",
    ".env",
  ];
  for (const p of denied) isTrue(isBlacklisted(p, SENSITIVE_FILE_PATTERNS), `${p} must be sensitive`);
  const allowed = ["/proj/src/app.ts", "C:\\proj\\src\\App.tsx", "/proj/environment.ts", "/proj/src/identity.ts", "/proj/keyboard.ts"];
  for (const p of allowed) isFalse(isBlacklisted(p, SENSITIVE_FILE_PATTERNS), `${p} must stay allowed`);
});
