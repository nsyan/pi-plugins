// scan/save.ts —— 把已确认的候选写进主机清单。连接测试由调用方先做。
import { randomUUID } from "node:crypto";
import type { HostFile, HostProfile, TransportKind } from "../core/types.js";

export interface HostCandidate {
  name: string;
  host: string;
  user: string;
  port?: number;
  transport?: TransportKind | "auto";
  privateKeyPath?: string;
  secretRef?: string;
  tags?: string[];
}

export type SaveChoice = "overwrite" | "rename" | "skip";

export function saveHostCandidate(file: HostFile, candidate: HostCandidate, choice: SaveChoice = "overwrite"): { file: HostFile; saved: boolean; name: string } {
  let name = candidate.name;
  if (file.hosts[name]) {
    if (choice === "skip") return { file, saved: false, name };
    if (choice === "rename") {
      let suffix = 2;
      while (file.hosts[`${candidate.name}-${suffix}`]) suffix += 1;
      name = `${candidate.name}-${suffix}`;
    }
  }
  const profile: HostProfile = {
    id: file.hosts[name]?.id ?? randomUUID(),
    name,
    transport: candidate.transport ?? "auto",
    host: candidate.host,
    port: candidate.port,
    user: candidate.user,
    auth: {
      kind: candidate.privateKeyPath ? "key" : "password",
      privateKeyPath: candidate.privateKeyPath,
      secretRef: candidate.privateKeyPath ? undefined : candidate.secretRef,
    },
    tags: candidate.tags,
    createdAt: file.hosts[name]?.createdAt ?? new Date().toISOString(),
  };
  return {
    saved: true,
    name,
    file: { ...file, hosts: { ...file.hosts, [name]: profile } },
  };
}
