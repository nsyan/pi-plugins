// transports/ftp.ts —— FTP/FTPS 只有文件传输。没有远端 sha256。
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { TransferMismatchError, UnsupportedError, type HostProfile } from "../core/types.js";

const { Client } = createRequire(import.meta.url)("basic-ftp") as {
  Client: new () => {
    ftp: { verbose: boolean };
    access(options: Record<string, unknown>): Promise<void>;
    uploadFrom(local: string, remote: string, options?: { localStart?: number }): Promise<void>;
    appendFrom(local: string, remote: string, options?: { localStart?: number }): Promise<void>;
    downloadTo(local: string, remote: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    size(path: string): Promise<number>;
    list(path: string): Promise<Array<{ name: string; size: number; isDirectory: boolean }>>;
    close(): void;
  };
};

async function open(profile: HostProfile) {
  if (profile.active) throw new UnsupportedError("basic-ftp 5 只支持被动模式，主动模式无法开启。");
  const client = new Client();
  const secure = profile.transport === "ftps" ? (profile.secure === "implicit" ? "implicit" : true) : false;
  await client.access({
    host: profile.host,
    port: profile.port ?? (profile.secure === "implicit" ? 990 : 21),
    user: profile.user,
    password: profile.auth.secretRef,
    secure,
    secureOptions: profile.insecure ? { rejectUnauthorized: false } : undefined,
  });
  return client;
}

export async function ftpPut(profile: HostProfile, localPath: string, remotePath: string, backup = false): Promise<{ bytes: number; backupPath?: string }> {
  const client = await open(profile);
  try {
    const part = `${remotePath}.part`;
    let start = 0;
    try {
      start = await client.size(part);
    } catch {
      start = 0;
    }
    if (start > 0) await client.appendFrom(localPath, part, { localStart: start });
    else await client.uploadFrom(localPath, part);
    const bytes = statSync(localPath).size;
    const remoteBytes = await client.size(part);
    if (remoteBytes !== bytes) throw new TransferMismatchError(`FTP 字节数不一致：本地 ${bytes}，远端 ${remoteBytes}。${part} 保留，原文件未动`);
    let backupPath: string | undefined;
    if (backup) {
      const stamp = `${remotePath}.bak.${Date.now()}`;
      try {
        await client.rename(remotePath, stamp);
        backupPath = stamp;
      } catch {
        backupPath = undefined;
      }
    }
    await client.rename(part, remotePath);
    return { bytes, backupPath };
  } finally {
    client.close();
  }
}

export async function ftpGet(profile: HostProfile, remotePath: string, localPath: string): Promise<{ bytes: number }> {
  const client = await open(profile);
  try {
    await client.downloadTo(localPath, remotePath);
    return { bytes: statSync(localPath).size };
  } finally {
    client.close();
  }
}

export async function ftpList(profile: HostProfile, remotePath: string): Promise<Array<{ name: string; size: number; directory: boolean }>> {
  const client = await open(profile);
  try {
    const entries = await client.list(remotePath);
    return entries.map((entry) => ({ name: entry.name, size: entry.size, directory: entry.isDirectory }));
  } finally {
    client.close();
  }
}

export function ftpExecRejected(): never {
  throw new UnsupportedError("这台主机是 FTP/FTPS，只能传文件，不能执行命令。");
}
