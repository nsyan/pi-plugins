// test/registry.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry, register, type Dialect } from "../src/dialects/index.js";

const fake: Dialect = {
  id: "postgresql", label: "PostgreSQL", family: "relational", defaultPort: 5432,
  fingerprints: { urlPatterns: [/^jdbc:postgresql:\/\//], configKeys: ["spring.datasource.url"] },
  parseUrl: () => null,
  withConnection: async (_c, _fn) => { throw new Error("nope"); },
  testConnection: async () => ({ success: false, error: "nope" }),
  isAllowed: () => ({ ok: true }),
  executeOn: async () => ({ success: false, error: "nope" }),
  listTables: async () => ({ success: false, error: "nope" }),
  describeTable: async () => ({ success: false, error: "nope" }),
  displayUrl: () => "",
  versionQuery: async () => "",
};

describe("registry", () => {
  it("registers and resolves a dialect", () => {
    register(fake);
    assert.equal(registry.get("postgresql")?.label, "PostgreSQL");
  });
});
