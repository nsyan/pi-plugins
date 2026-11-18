// core/known-hosts.ts —— 解析 OpenSSH known_hosts。证书行只解析、不作为信任依据。
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";

export type HostKeyStatus = "match" | "unknown" | "changed" | "revoked";

interface KnownHostLine {
  marker?: string;
  patterns: string[];
  keyType: string;
  key: string;
}

/** OpenSSH 的 SHA256 指纹：密钥原文的 sha256，base64，去掉末尾等号。 */
export function hostKeyFingerprint(key: Buffer): string {
  const digest = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

export function hostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function appendKnownHost(file: string, host: string, port: number, keyType: string, key: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${hostToken(host, port)} ${keyType} ${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function parseLine(line: string): KnownHostLine | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const parts = trimmed.split(/\s+/);
  let marker: string | undefined;
  if (parts[0]?.startsWith("@")) {
    marker = parts.shift();
  }
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  return { marker, patterns: parts[0].split(","), keyType: parts[1], key: parts[2] };
}

function hashedMatch(pattern: string, presented: string): boolean {
  const match = /^\|1\|([^|]+)\|([^|]+)$/.exec(pattern);
  if (!match) return false;
  const salt = Buffer.from(match[1], "base64");
  const expected = Buffer.from(match[2], "base64");
  const actual = createHmac("sha1", salt).update(presented).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function patternMatches(pattern: string, host: string, port: number): boolean {
  if (pattern.startsWith("|1|")) return hashedMatch(pattern, hostToken(host, port));
  return pattern === hostToken(host, port) || (port === 22 && pattern === host);
}

function lineMatches(line: KnownHostLine, host: string, port: number): boolean {
  return line.patterns.some((pattern) => patternMatches(pattern, host, port));
}

export function checkHostKey(
  file: string,
  host: string,
  port: number,
  keyType: string,
  key: string,
): HostKeyStatus {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "unknown";
  }
  const lines = text
    .split("\n")
    .map(parseLine)
    .filter((line): line is KnownHostLine => line !== null)
    .filter((line) => lineMatches(line, host, port));

  const sameType = lines.filter((line) => line.keyType === keyType);
  if (sameType.some((line) => line.marker === "@revoked" && line.key === key)) return "revoked";
  const plain = sameType.filter((line) => line.marker !== "@revoked" && line.marker !== "@cert-authority");
  if (plain.some((line) => line.key === key)) return "match";
  if (plain.some((line) => line.key !== key)) return "changed";
  return "unknown";
}
