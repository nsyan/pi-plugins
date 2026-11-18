import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeHosts } from "../src/prompt.js";
import type { HostProfile } from "../src/core/types.js";

function host(name: string): HostProfile {
  return {
    id: name,
    name,
    transport: "ssh2",
    host: "10.0.0.21",
    user: "deploy",
    auth: { kind: "key" },
    createdAt: "2026-11-18T00:00:00.000Z",
  };
}

describe("describeHosts", () => {
  it("一台时允许省略 host", () => {
    const text = describeHosts({ hosts: { web: host("web") }, activeHost: "web" });
    assert.match(text, /host 可以省略/);
  });

  it("超过 20 台只保留活动主机", () => {
    const hosts = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`h${index}`, host(`h${index}`)]));
    const text = describeHosts({ hosts, activeHost: "h0" });
    assert.match(text, /共 21 台/);
    assert.equal(text.includes("h20"), false);
  });
});
