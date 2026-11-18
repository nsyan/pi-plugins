// core/types.ts —— 主机、传输结果与错误类型。零 pi 依赖。

export type TransportKind = "ssh2" | "openssh" | "ftp" | "ftps";
export type AuthKind = "key" | "password" | "agent";

export interface HostAuth {
  kind: AuthKind;
  secretRef?: string;
  privateKeyPath?: string;
  passphraseRef?: string;
  /** 只活在这次连接的内存里，不写回配置。 */
  password?: string;
  /** 只活在这次连接的内存里，不写回配置。 */
  passphrase?: string;
}

export interface DeployLayout {
  root: string;
  releasesDir?: string;
  currentLink?: string;
  sharedDir?: string;
  restartCmd?: string;
  healthCmd?: string;
  keepReleases?: number;
}

export interface HostProfile {
  id: string;
  name: string;
  transport: TransportKind | "auto";
  host: string;
  port?: number;
  user: string;
  auth: HostAuth;
  strictHostKey?: boolean;
  secure?: "explicit" | "implicit";
  active?: boolean;
  insecure?: boolean;
  tags?: string[];
  defaults?: { cwd?: string; timeoutSec?: number };
  deploy?: DeployLayout;
  createdAt: string;
  lastUsedAt?: string;
}

export interface HostFile {
  hosts: Record<string, HostProfile>;
  activeHost?: string;
  policy?: { readonly: boolean; confirm: "destructive" | "write" | "always" };
}

export const EMPTY_HOST_FILE: HostFile = { hosts: {} };

export class SshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class HostKeyUnknownError extends SshError {}
export class HostKeyChangedError extends SshError {}
export class AuthFailedError extends SshError {}
export class UnsupportedError extends SshError {}
export class PolicyDeniedError extends SshError {}
export class ConfirmRejectedError extends SshError {}
export class BoundsError extends SshError {}
export class TransferMismatchError extends SshError {}
export class AuditUnavailableError extends SshError {}
