// core/hash.ts —— 本地与远端都用同一种 sha256。远端按命令依次降级。
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { shellQuote } from "./guard.js";

export async function sha256File(path: string): Promise<{ hash: string; bytes: number }> {
  const info = await stat(path);
  const handle = await open(path, constants.O_RDONLY);
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream() as AsyncIterable<Uint8Array>) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return { hash: hash.digest("hex"), bytes: info.size };
}

export function remoteHashCommand(remotePath: string): string {
  const quoted = shellQuote(remotePath);
  return `sha256sum ${quoted} 2>/dev/null || shasum -a 256 ${quoted} 2>/dev/null || openssl dgst -sha256 ${quoted}`;
}

export function parseRemoteHash(stdout: string): string | undefined {
  return stdout.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
}

/** 按字节截断，不把多字节字符从中间切开。 */
export function clipUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0b11000000) === 0b10000000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
