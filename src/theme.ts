import base from "picocolors";

/**
 * OpenCode's default dark theme ("opencode").
 * Values come from packages/tui/src/theme/assets/v2/opencode.json.
 */
export const theme = {
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  info: "#56b6c2",
  text: "#eeeeee",
  muted: "#808080",
  background: "#0a0a0a",
  panel: "#141414",
  element: "#1e1e1e",
  border: "#484848",
} as const;

const enabled = base.isColorSupported;
const truecolor =
  enabled &&
  (/truecolor|24bit/i.test(process.env.COLORTERM ?? "") ||
    /^(iTerm\.app|WezTerm|vscode|Hyper|Tabby|rio)$/i.test(
      process.env.TERM_PROGRAM ?? "",
    ));

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function ansi256(hex: string): number {
  const [r, g, b] = rgb(hex);
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const toCube = (value: number) => Math.round((value / 255) * 5);
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}

function paint(hex: string, text: string): string {
  if (!enabled) return text;
  if (truecolor) {
    const [r, g, b] = rgb(hex);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  }
  return `\x1b[38;5;${ansi256(hex)}m${text}\x1b[39m`;
}

const bold = (text: string) => (enabled ? `\x1b[1m${text}\x1b[22m` : text);

/**
 * Drop-in replacement for picocolors using OpenCode's palette.
 * The old method names keep working, semantic names are preferred in new code.
 */
export const oc = {
  bold,
  dim: (text: string) => paint(theme.muted, text),
  cyan: (text: string) => paint(theme.info, text),
  green: (text: string) => paint(theme.success, text),
  red: (text: string) => paint(theme.error, text),
  yellow: (text: string) => paint(theme.warning, text),
  magenta: (text: string) => paint(theme.accent, text),
  blue: (text: string) => paint(theme.secondary, text),
  primary: (text: string) => paint(theme.primary, text),
  secondary: (text: string) => paint(theme.secondary, text),
  accent: (text: string) => paint(theme.accent, text),
  info: (text: string) => paint(theme.info, text),
  success: (text: string) => paint(theme.success, text),
  error: (text: string) => paint(theme.error, text),
  warning: (text: string) => paint(theme.warning, text),
  muted: (text: string) => paint(theme.muted, text),
  text: (text: string) => paint(theme.text, text),
};

export default oc;
