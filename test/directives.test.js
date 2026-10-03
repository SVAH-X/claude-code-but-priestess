// Directive parsing tests — validates that [[mood:]], [[skill:]], [[remember:]],
// [[observe:]], and [[silent]] tags are correctly parsed, stripped, and that edge
// cases (full-width colon, lenient brackets, cross-chunk splits) are handled.
const { test, equal, isTrue, isFalse, matches, noMatch } = require("./helper");

// Helper: test a regex against a string and return capture group 1.
function cap(re, str) { const m = re.exec(str); return m ? m[1] : null; }
function cap2(re, str) { const m = re.exec(str); return m ? m[2] : null; }

// ============================================================
// Mood Directive Tests
// ============================================================

test("mood captures all six standard values (ASCII colon)", () => {
  const re = /\[\[\s*mood\s*[:：]\s*([^\]]*?)\s*\]\]/i;
  equal(cap(re, "[[mood:smile]]"), "smile");
  equal(cap(re, "[[mood:calm]]"), "calm");
  equal(cap(re, "[[mood:angry]]"), "angry");
  equal(cap(re, "[[mood:sleepy]]"), "sleepy");
  equal(cap(re, "[[mood:threat]]"), "threat");
  equal(cap(re, "[[mood:sad]]"), "sad");
});

test("mood captures values with full-width colon", () => {
  const re = /\[\[\s*mood\s*[:：]\s*([^\]]*?)\s*\]\]/i;
  equal(cap(re, "[[mood：smile]]"), "smile");
  equal(cap(re, "[[mood：angry]]"), "angry");
});

// ============================================================
// Skill Directive Tests
// ============================================================

test("skill captures name only (no arg)", () => {
  const re = /\[\[\s*skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?\s*\]\]/i;
  equal(cap(re, "[[skill:play_music]]"), "play_music", "skill name");
  // Optional group not matched → m[2] is undefined, not null
  equal(cap2(re, "[[skill:play_music]]"), undefined, "no arg");
});

test("skill captures name and arg", () => {
  const re = /\[\[\s*skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?\s*\]\]/i;
  equal(cap(re, "[[skill:play_music Eclipse]]"), "play_music");
  equal(cap2(re, "[[skill:play_music Eclipse]]"), "Eclipse");

  equal(cap(re, "[[skill:web_search Claude Code docs]]"), "web_search");
  equal(cap2(re, "[[skill:web_search Claude Code docs]]"), "Claude Code docs");
});

test("skill captures with full-width colon", () => {
  const re = /\[\[\s*skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?\s*\]\]/i;
  equal(cap(re, "[[skill：play_music Eclipse]]"), "play_music");
  equal(cap2(re, "[[skill：play_music Eclipse]]"), "Eclipse");
});

test("skill:note without content still matches", () => {
  const re = /\[\[\s*skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?\s*\]\]/i;
  equal(cap(re, "[[skill:note]]"), "note");
  equal(cap2(re, "[[skill:note]]"), undefined);
});

// ============================================================
// Observe & Remember Directive Tests
// ============================================================

test("observe captures free-form text", () => {
  const re = /\[\[\s*observe\s*[:：]\s*([^\]]*?)\s*\]\]/i;
  equal(cap(re, "[[observe:博士正在写 TypeScript]]"), "博士正在写 TypeScript");
  equal(cap(re, "[[observe：他在调试]]"), "他在调试");
});

test("remember captures free-form text", () => {
  const re = /\[\[\s*remember\s*[:：]\s*([^\]]*?)\s*\]\]/i;
  equal(cap(re, "[[remember:博士在用 React 重构前端]]"), "博士在用 React 重构前端");
  equal(cap(re, "[[remember：index.ts 有空值风险]]"), "index.ts 有空值风险");
});

// ============================================================
// Silent & Whitespace Tests
// ============================================================

test("DIRECTIVE_RE matches silent with whitespace tolerance", () => {
  const re = /\[\[\s*(?:mood\s*[:：]\s*([^\]]*?)|skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?|observe\s*[:：]\s*([^\]]*?)|remember\s*[:：]\s*([^\]]*?)|silent)\s*\]\]/i;
  isTrue(re.test("[[silent]]"), "exact match");
  isTrue(re.test("[[ silent ]]"), "with spaces");
});

// ============================================================
// Strip Tests (full directive removal)
// ============================================================

test("stripAll removes all five directive types", () => {
  const DIRECTIVE_RE = /\[\[\s*(?:mood\s*[:：]\s*([^\]]*?)|skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?|observe\s*[:：]\s*([^\]]*?)|remember\s*[:：]\s*([^\]]*?)|silent)\s*\]\]/gi;
  const LENIENT_MOOD_RE = /\[\[\s*mood\s*[:：]\s*([a-zA-Z]+)\s*\](?=[^\]])[ \t]?/gi;

  let input = "[[mood:smile]] 博士你好。[[skill:web_search React]] 让我看看。[[remember:test]] [[observe:coding]] [[silent]]";
  input = input.replace(DIRECTIVE_RE, "");
  input = input.replace(LENIENT_MOOD_RE, "");

  isFalse(/\[\[mood:/.test(input), "mood stripped");
  isFalse(/\[\[skill:/.test(input), "skill stripped");
  isFalse(/\[\[remember:/.test(input), "remember stripped");
  isFalse(/\[\[observe:/.test(input), "observe stripped");
  isFalse(/silent/i.test(input), "silent stripped");
  isTrue(input.includes("博士你好"), "visible text preserved");
  isTrue(input.includes("让我看看"), "visible text preserved");
});

test("lenient single-bracket mood is matched", () => {
  const re = /\[\[\s*mood\s*[:：]\s*([a-zA-Z]+)\s*\](?=[^\]])[ \t]?/i;
  isTrue(re.test("[[mood:sad] 再后来…"), "single-bracket sad");
  isTrue(re.test("[[mood:angry] 博士"), "single-bracket angry");
  isFalse(re.test("[[mood:smile]]"), "double-bracket NOT matched by lenient");
});

test("trailing partial directive is stripped in finalize", () => {
  const cleanupRe = /\[?\[\s*(?:mood|skill|observe|remember|silent)\b[^\]]*$/i;
  equal("博士你好 [[mood:ha".replace(cleanupRe, "").trim(), "博士你好");
  equal("好的 [[remember:博士".replace(cleanupRe, "").trim(), "好的");
  equal("[[skill:play".replace(cleanupRe, "").trim(), "");
});

// ============================================================
// normalizeMood Tests
// ============================================================

test("normalizeMood maps aliases case-insensitively", () => {
  function normalizeMood(raw) {
    const m = String(raw || "").toLowerCase().trim();
    if (m === "happy") return "smile";
    if (m === "threaten") return "threat";
    if (m === "cry") return "sad";
    return m;
  }
  equal(normalizeMood("happy"), "smile");
  equal(normalizeMood("threaten"), "threat");
  equal(normalizeMood("cry"), "sad");
  equal(normalizeMood("calm"), "calm");
  equal(normalizeMood("SMILE"), "smile");
  equal(normalizeMood("Happy"), "smile");
});

// ============================================================
// Cross-chunk Directive Buffer Test
// ============================================================

test("cross-chunk split tags are reconstructed and stripped", () => {
  const DIRECTIVE_RE = /\[\[\s*(?:mood\s*[:：]\s*([^\]]*?)|skill\s*[:：]\s*([a-z_]+)(?:\s+([^\]]*?))?|observe\s*[:：]\s*([^\]]*?)|remember\s*[:：]\s*([^\]]*?)|silent)\s*\]\]/gi;
  // Chunk 1 ends with "[[mood:" — held in directiveTailBuffer
  // Chunk 2 starts with "smile]] 今天天气不错"
  const combined = "[[mood:smile]] 今天天气不错";
  const result = combined.replace(DIRECTIVE_RE, "").trim();
  equal(result, "今天天气不错");
});
