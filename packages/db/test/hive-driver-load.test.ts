// test/hive-driver-load.test.ts —— 回归：hive-driver 加载链（hive-driver → thrift → isomorphic-ws → ws）必须完整
//
// 背景（1.3.4 线上事故，见 CHANGELOG 1.3.5）：isomorphic-ws 把 `ws` 声明为
// peerDependencies（自身无实体依赖）。npm 扁平安装时 thrift 自带的 ws@5 可能只嵌套在
// `thrift/node_modules` 而未提升到安装根，此时 isomorphic-ws 的 `require('ws')` 直接
// `Cannot find module 'ws'`——而 index.ts 顶层静态 import 全部方言（含 hive/spark），
// 一条链炸掉整个扩展（6 工具 + /db 全部注册不上，且 pi 静默吞掉加载错误）。
// 本地 pnpm 因严格布局 + auto-install-peers 把 peer 自动补齐，开发期完全无感。
// 修复：package.json dependencies 显式声明 ws；本测试保证该链在
// pnpm（严格布局）与 npm（扁平布局）下都可解析——若有人移除 ws 依赖，这里先红。
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("hive-driver load chain regression", () => {
  it("ws 可解析（isomorphic-ws 的 peer 依赖，必须显式声明）", async () => {
    const ws = await import("ws");
    assert.ok(ws, "require('ws') 应成功");
  });

  it("hive-driver 可加载（真实链路触发 thrift → isomorphic-ws → ws）", async () => {
    const hive = await import("hive-driver");
    assert.ok(hive, "hive-driver 应可导入");
  });
});
