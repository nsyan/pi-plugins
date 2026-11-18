// scan/auto.ts —— auto 每次连接时看 ~/.ssh/config，不把结果存进 profile。
import { parseSshConfig } from "./ssh-config.js";
import type { HostProfile, TransportKind } from "../core/types.js";

export function chooseTransport(profile: HostProfile, sshConfigText: string): Exclude<HostProfile["transport"], "auto"> {
  if (profile.transport !== "auto") return profile.transport;
  const hosts = parseSshConfig(sshConfigText);
  const match = hosts.find((item) => item.hostName === profile.host || item.name === profile.name || item.aliases.includes(profile.host));
  return match?.needsOpenSsh ? "openssh" : "ssh2";
}

export type ConcreteTransport = TransportKind;
