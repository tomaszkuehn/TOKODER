/**
 * Minimal terminal markdown renderer for chat output.
 * Converts markdown text into plain text with ANSI color codes so AI answers
 * render readably in the Ink viewport (which passes raw lines through).
 *
 * Supported: headers (#..###), bold, italic, inline code, fenced code blocks,
 * bullet/numbered lists, blockquotes, tables (simple), horizontal rules, links.
 * Inline formatting uses ANSI escapes so a single wrapped line keeps colors.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
};

const C = {
  heading: ANSI.bold + ANSI.cyan,
  bold: ANSI.bold + ANSI.white,
  code: ANSI.green,
  codeBlockBorder: ANSI.gray,
  codeBlock: ANSI.green,
  bullet: ANSI.magenta,
  quote: ANSI.blue,
  link: ANSI.cyan,
  rule: ANSI.gray,
  table: ANSI.cyan,
  dim: ANSI.dim,
};

/** inline: **bold**, *italic*, `code`, [text](url) → colored spans */
export function renderInlineMd(text: string): string {
  let out = text;
  // inline code first (protects its content from other rules)
  out = out.replace(/`([^`]+)`/g, `${C.code}$1${ANSI.reset}`);
  // bold **x** or __x__
  out = out.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${ANSI.reset}`);
  out = out.replace(/__([^_]+)__/g, `${C.bold}$1${ANSI.reset}`);
  // italic *x* (avoid matching inside words like 2*3*4? keep simple)
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, `$1${ANSI.italic}$2${ANSI.reset}`);
  // links [text](url) → text (url) with url dimmed
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.link}$1${ANSI.reset}${C.dim} ($2)${ANSI.reset}`);
  return out;
}

/** block: markdown source → array of display lines with ANSI */
export function renderMarkdown(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  let inCode = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      const lang = raw.replace(/^\s*```/, "").trim();
      inCode = !inCode;
      out.push(`${C.codeBlockBorder}-${lang ? " " + lang : ""}${ANSI.reset}`);
      continue;
    }
    if (inCode) {
      out.push(`${C.codeBlock}${raw}${ANSI.reset}`);
      continue;
    }
    // horizontal rule
    if (/^\s*([-*_])\s*\1{2,}\s*$/.test(raw)) {
      out.push(`${C.rule}${"-".repeat(20)}${ANSI.reset}`);
      continue;
    }
    // headings
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const bar = level <= 2 ? "|" : "·";
      out.push(`${C.heading}${bar} ${h[2]}${ANSI.reset}`);
      continue;
    }
    // blockquote
    const q = raw.match(/^\s*>\s?(.*)$/);
    if (q) {
      out.push(`${C.quote}| ${q[1]}${ANSI.reset}`);
      continue;
    }
    // table row (| a | b |) or separator
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue; // separator row → skip
      const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      out.push(`${C.table}| ${cells.join(" | ")}${ANSI.reset}`);
      continue;
    }
    // bullets
    const b = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (b) {
      const marker = /^\d/.test(b[2]) ? b[2] : "-";
      out.push(`${b[1]}${C.bullet}${marker}${ANSI.reset} ${renderInlineMd(b[3])}`);
      continue;
    }
    out.push(renderInlineMd(raw));
  }
  return out;
}

/** strip ANSI - for transcript dump / tests */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Make arbitrary text safe for a CP437 console: replace common emoji/unicode
 * decorations (which the model may emit) with ASCII equivalents, and drop
 * anything else outside Latin-1 so conhost never renders garbage.
 */
const EMOJI_MAP: Record<string, string> = {
  "\u2705": "[OK]",       // ✅
  "\u26A0\uFE0F": "[!]",  // ⚠️
  "\u26A0": "[!]",        // ⚠
  "\u274C": "[X]",        // ❌
  "\u2714": "[OK]",       // ✔
  "\u2716": "[X]",        // ✖
  "\u2757": "[!]",        // ❗
  "\u2753": "[?]",        // ❓
  "\u2754": "[?]",        // ❔
  "\u2764": "<3",         // ❤
  "\u2B50": "*",          // ⭐
  "\u1F512": "[lock]",    // 🔒
  "\u26A1": ">",          // ⚡
  "\u23F3": "..",         // ⏳
  "\u26D4": "STOP",       // ⛔
  "\u2699": "*",          // ⚙
  "\u2699\uFE0F": "*",
  "\u2692": "*",          // ⚒
  "\u1F527": "[tool]",    // 🔧
  "\u1F4DD": "[note]",    // 📝
  "\u1F4CC": "[pin]",     // 📌
  "\u1F680": "[go]",      // 🚀
  "\u1F4A1": "[idea]",    // 💡
  "\u1F3AF": "[target]",  // 🎯
  "\u1F4CB": "[list]",    // 📋
  "\u1F50E": "[search]",  // 🔎
  "\u1F9EA": "[test]",    // 🧪
  "\u21BB": "+",          // ↻
  "\u2705\uFE0F": "[OK]",
  "\uFE0F": "",           // stray variation selector
  "\u200D": "",           // zero-width joiner
  "\u20E3": "",           // combining keycap
};

export function sanitizeCp437(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [k, v] of Object.entries(EMOJI_MAP)) out = out.split(k).join(v);
  // drop any remaining char outside ASCII (arrows/glyphs we whitelist render fine elsewhere, but model output must be safe)
  out = out.replace(/[^\x00-\x7F]/g, "");
  return out;
}

export { ANSI };