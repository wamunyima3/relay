/**
 * Secret redaction.
 *
 * The brief is emphatic (§4): redaction is mandatory and must run before any
 * conversation leaves the machine. We scan transcript text and tool output for
 * known secret shapes and replace them with a typed placeholder. The matchers
 * favour precision (recognizable token prefixes, structural patterns) so we
 * don't mangle ordinary prose, but the env/assignment rule provides a
 * fail-closed catch-all for `SECRET=...` style leakage.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Build the replacement, given the full match. */
  replace?: (match: string) => string;
}

const mask = (label: string) => () => `[REDACTED:${label}]`;

/**
 * Ordered list of rules. Order matters: more specific token rules run before
 * the generic assignment rule so we label leaks precisely.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  // --- Provider API keys (distinctive prefixes) ---
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: mask("anthropic-key") },
  { name: "openai-key", pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: mask("openai-key") },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g, replace: mask("github-token") },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{60,}/g, replace: mask("github-pat") },
  { name: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: mask("slack-token") },
  { name: "google-key", pattern: /AIza[A-Za-z0-9_-]{35}/g, replace: mask("google-key") },
  { name: "stripe-key", pattern: /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: mask("stripe-key") },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: mask("aws-access-key") },

  // --- Structural secrets ---
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    replace: mask("private-key"),
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: mask("jwt"),
  },
  {
    name: "bearer",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{16,}/g,
    replace: () => "Bearer [REDACTED:bearer]",
  },

  // --- Fail-closed catch-all: SECRET-ish assignments ---
  // Matches KEY=value / "key": "value" where the key name looks sensitive.
  {
    name: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTH)[A-Za-z0-9_]*)\b(\s*[:=]\s*)(['"]?)([^\s'"]{6,})\3/gi,
    replace: (m) => {
      // Preserve the key and operator, mask only the value.
      const match = /^(.*?[:=]\s*)(['"]?)([^\s'"]{6,})\2$/s.exec(m);
      if (!match) return "[REDACTED:secret]";
      return `${match[1]}${match[2]}[REDACTED:secret]${match[2]}`;
    },
  },
];

export interface RedactionResult {
  text: string;
  hits: { rule: string; count: number }[];
  total: number;
}

/** Run all rules over a string, returning the cleaned text and a hit report. */
export function redactString(input: string, rules: RedactionRule[] = DEFAULT_RULES): RedactionResult {
  let text = input;
  const counts = new Map<string, number>();
  for (const rule of rules) {
    text = text.replace(rule.pattern, (match) => {
      counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1);
      return rule.replace ? rule.replace(match) : "[REDACTED]";
    });
  }
  const hits = [...counts.entries()].map(([rule, count]) => ({ rule, count }));
  const total = hits.reduce((n, h) => n + h.count, 0);
  return { text, hits, total };
}
