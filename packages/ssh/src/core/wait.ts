// core/wait.ts —— 把等待收成远端一条循环，避免本地反复探活。
import { shellQuote } from "./guard.js";

export interface WaitFor {
  port?: number;
  http?: string;
  file?: string;
  timeoutSec: number;
}

export function waitCommand(wait: WaitFor): string {
  const ticks = Math.max(1, Math.floor(wait.timeoutSec));
  const port = Number(wait.port);
  if (wait.port !== undefined && Number.isInteger(port) && port > 0 && port < 65536) {
    const body = `for i in $(seq 1 ${ticks}); do (echo >/dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1 && exit 0; command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 ${port} && exit 0; sleep 1; done; exit 1`;
    return `bash -c ${shellQuote(body)}`;
  }
  if (wait.http) {
    const url = shellQuote(wait.http);
    const body = `for i in $(seq 1 ${ticks}); do curl -fsS -m 2 ${url} >/dev/null 2>&1 && exit 0; command -v wget >/dev/null 2>&1 && wget -q -T 2 -O /dev/null ${url} && exit 0; sleep 1; done; exit 1`;
    return `bash -c ${shellQuote(body)}`;
  }
  if (wait.file) {
    const file = shellQuote(wait.file);
    const body = `for i in $(seq 1 ${ticks}); do test -e ${file} && exit 0; sleep 1; done; exit 1`;
    return `bash -c ${shellQuote(body)}`;
  }
  throw new Error("waitFor 需要 port、http 或 file 其中一个");
}
