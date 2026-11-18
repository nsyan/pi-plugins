import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saveHostCandidate } from "../src/scan/save.js";
import { EMPTY_HOST_FILE } from "../src/core/types.js";

describe("saveHostCandidate", () => {
  const candidate = { name: "web", host: "10.0.0.21", user: "deploy", privateKeyPath: "~/.ssh/web" };

  it("新主机写入，同名可以跳过或改名", () => {
    const first = saveHostCandidate(EMPTY_HOST_FILE, candidate);
    assert.equal(first.saved, true);
    assert.equal(first.file.hosts.web.auth.privateKeyPath, "~/.ssh/web");
    const skipped = saveHostCandidate(first.file, candidate, "skip");
    assert.equal(skipped.saved, false);
    const renamed = saveHostCandidate(first.file, candidate, "rename");
    assert.equal(renamed.name, "web-2");
  });
});
