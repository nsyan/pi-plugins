import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseTransport } from "../src/scan/auto.js";
import type { HostProfile } from "../src/core/types.js";

const profile = {
  id: "web",
  name: "web",
  transport: "auto",
  host: "10.0.0.21",
  user: "deploy",
  auth: { kind: "key" },
  createdAt: "2026-11-18T00:00:00.000Z",
} satisfies HostProfile;

describe("chooseTransport", () => {
  it("有跳板就用系统 ssh，否则用 ssh2", () => {
    assert.equal(chooseTransport(profile, "Host web\n  HostName 10.0.0.21\n  ProxyJump bastion\n"), "openssh");
    assert.equal(chooseTransport(profile, "Host web\n  HostName 10.0.0.21\n"), "ssh2");
    assert.equal(chooseTransport({ ...profile, transport: "ftp" }, ""), "ftp");
  });
});
