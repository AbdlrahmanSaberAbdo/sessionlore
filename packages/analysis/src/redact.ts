/**
 * Replaces secrets with typed placeholders such as `[REDACTED:api-key]`
 * before any text is sent to the Model Provider: known secret patterns first,
 * then any remaining high-entropy string.
 */

export type SecretKind =
  | "private-key"
  | "password"
  | "aws-access-key"
  | "api-key"
  | "token"
  | "jwt"
  | "secret"
  | "high-entropy";

const placeholder = (kind: SecretKind): string => `[REDACTED:${kind}]`;

interface Pattern {
  kind: SecretKind;
  regex: RegExp;
  /**
   * When true, capture group 1 is a prefix to keep and group 2 the secret;
   * anything after the secret is kept too. Otherwise the whole match is the secret.
   */
  prefixed?: boolean;
}

const patterns: Pattern[] = [
  { kind: "private-key", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g },
  // Credentials in URLs and connection strings: scheme://user:password@host
  { kind: "password", regex: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)/gi, prefixed: true },
  { kind: "aws-access-key", regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "api-key", regex: /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "api-key", regex: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "token", regex: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: "token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "token", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "token", regex: /(\bBearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, prefixed: true },
  // KEY=value and key: value assignments of anything named like a secret.
  {
    kind: "secret",
    regex: /(\b[A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)([^\s"'[]{6,})/gi,
    prefixed: true,
  },
];

const candidate = /[A-Za-z0-9+_=-]{20,}/g;

export function redact(text: string): string {
  let result = text;
  for (const { kind, regex, prefixed } of patterns) {
    result = result.replace(regex, (match: string, prefix: unknown, secret: unknown) => {
      if (!prefixed) return placeholder(kind);
      const kept = String(prefix);
      return kept + placeholder(kind) + match.slice(kept.length + String(secret).length);
    });
  }
  return result.replace(candidate, (token) => (looksRandom(token) ? placeholder("high-entropy") : token));
}

/** Long strings mixing letters and digits with high Shannon entropy, like generated keys and tokens. */
function looksRandom(token: string): boolean {
  const digits = token.replace(/[^0-9]/g, "").length;
  if (digits < 2 || !/[A-Za-z]/.test(token)) return false;
  return shannonEntropy(token) >= 4;
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
