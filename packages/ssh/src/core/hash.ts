// core/hash.ts —— 本地与远端都用同一种 sha256。远端按命令依次降级。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { shellQuote } from "./guard.js";

/**
 * 本地文件的 sha256。
 * 目录必须先挡掉：`readableWebStream()` 对目录抛的 EISDIR 会逃成 unhandledRejection，
 * 在长驻宿主里直接把进程打掉，`try/catch` 拦不住。用 createReadStream 的异步迭代器，
 * 错误才会老老实实落到 await 上。
 */
export async function sha256File(path: string): Promise<{ hash: string; bytes: number }> {
  const info = await stat(path);
  if (info.isDirectory()) {
    throw new Error(`${path} 是目录。上传不接受目录：先在本地打成一个压缩包，再传包。`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
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
