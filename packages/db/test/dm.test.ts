// test/dm.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dmDialect } from "../src/dialects/dm.js";

describe("dm", () => {
  it("parses dm jdbc url with default port", () => {
    assert.deepEqual(dmDialect.parseUrl("jdbc:dm://h/myschema"),
      { host: "h", port: 5236, database: "myschema" });
  });
  it("parses dm url without path, taking schema= from query (lszg 形态)", () => {
    assert.deepEqual(
      dmDialect.parseUrl("jdbc:dm://10.2.12.50:32036?schema=zhrs_ls&zeroDateTimeBehavior=convertToNull"),
      { host: "10.2.12.50", port: 32036, database: "zhrs_ls" },
    );
  });
  it("parses dm url without path and without schema (database 可选)", () => {
    assert.deepEqual(dmDialect.parseUrl("jdbc:dm://h:5236"), { host: "h", port: 5236 });
  });
  it("path takes precedence over schema param", () => {
    assert.deepEqual(
      dmDialect.parseUrl("jdbc:dm://h/dbname?schema=other"),
      { host: "h", port: 5236, database: "dbname" },
    );
  });
  it("masks password in display", () => {
    const shown = dmDialect.displayUrl({ id: "x", name: "n", type: "dm", host: "h", port: 5236, username: "u", password: "secret", database: "s", createdAt: "" });
    assert.ok(!shown.includes("secret") && shown.includes("jdbc:dm://"));
  });
  it("display omits database part when absent", () => {
    const shown = dmDialect.displayUrl({ id: "x", name: "n", type: "dm", host: "h", port: 5236, username: "u", password: "p", createdAt: "" });
    assert.equal(shown, "jdbc:dm://h:5236");
  });
});
