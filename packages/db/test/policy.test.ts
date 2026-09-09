// test/policy.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/core/policy.js";

describe("decide", () => {
  it("denies when verdict not ok", () => {
    assert.equal(decide({ ok: false, reason: "x" }, true, "write"), "deny");
  });
  it("runs read directly under write-confirm", () => {
    assert.equal(decide({ ok: true, isWrite: false }, true, "write"), "run");
  });
  it("confirms write under write-confirm", () => {
    assert.equal(decide({ ok: true, isWrite: true }, false, "write"), "confirm");
  });
  it("confirms everything under always", () => {
    assert.equal(decide({ ok: true, isWrite: false }, true, "always"), "confirm");
  });
  it("runs everything under never (except denied)", () => {
    assert.equal(decide({ ok: true, isWrite: true }, false, "never"), "run");
  });
});
