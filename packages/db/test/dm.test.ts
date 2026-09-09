// test/dm.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dmDialect } from "../src/dialects/dm.js";

describe("dm", () => {
  it("parses dm jdbc url with default port", () => {
    assert.deepEqual(dmDialect.parseUrl("jdbc:dm://h/myschema"),
      { host: "h", port: 5236, database: "myschema" });
  });
  it("masks password in display", () => {
    const shown = dmDialect.displayUrl({ id: "x", name: "n", type: "dm", host: "h", port: 5236, username: "u", password: "secret", database: "s", createdAt: "" });
    assert.ok(!shown.includes("secret") && shown.includes("jdbc:dm://"));
  });
});
