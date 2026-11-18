import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import { describe, it } from "node:test";
import { clipUtf8 } from "../src/core/hash.js";

/**
 * 这一组测的是「流式读取不切多字节字符」。
 * 真机 E2E 发现：ssh_read 读 600KB 中文时返回含 U+FFFD——根因不是 clipUtf8，
 * 而是 SFTP/exec 的 data 块边界与字符边界无关，逐块 chunk.toString("utf8")
 * 会把一个 3 字节汉字切成两半，两块各解出一个替换符。
 * 修复用的是 StringDecoder 续接。这里同时钉住「朴素做法确实会坏」这个前提，
 * 避免以后有人把它「简化」回去。
 */
describe("多字节字符的流式解码", () => {
  const text = "中文日志：部署成功 ✅ done";
  const buf = Buffer.from(text, "utf8");

  /** 按任意字节位置切块，模拟 SFTP 的 32KB / 64KB 块 */
  const chunksAt = (size: number): Buffer[] => {
    const out: Buffer[] = [];
    for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
    return out;
  };

  it("朴素逐块 toString 会切出替换符（这就是真机上的 bug）", () => {
    let naive = "";
    for (const chunk of chunksAt(7)) naive += chunk.toString("utf8");
    assert.equal(naive.includes("\uFFFD"), true);
    assert.notEqual(naive, text);
  });

  it("StringDecoder 续接后与原文完全一致", () => {
    for (const size of [1, 2, 3, 5, 7, 11, 13]) {
      const decoder = new StringDecoder("utf8");
      let value = "";
      for (const chunk of chunksAt(size)) value += decoder.write(chunk);
      value += decoder.end();
      assert.equal(value, text, `块大小 ${size} 时解码结果应与原文一致`);
      assert.equal(value.includes("\uFFFD"), false);
    }
  });

  it("600KB 中文按 32KB 切块也不出替换符", () => {
    const big = Buffer.from("中".repeat(200000), "utf8");
    const decoder = new StringDecoder("utf8");
    let value = "";
    for (let i = 0; i < big.length; i += 32768) value += decoder.write(big.subarray(i, i + 32768));
    value += decoder.end();
    assert.equal(value.length, 200000);
    assert.equal(/^中+$/.test(value), true);
  });
});

describe("clipUtf8 按字符边界截断", () => {
  it("只保留完整的字符，不切半个", () => {
    const s = "中中中"; // 每个 3 字节
    const cases: Array<[number, string]> = [
      [1, ""],
      [2, ""],
      [3, "中"],
      [5, "中"],
      [6, "中中"],
      [8, "中中"],
      [9, "中中中"],
    ];
    for (const [limit, expected] of cases) {
      assert.equal(clipUtf8(s, limit), expected, `limit=${limit}`);
    }
  });

  it("不超限时原样返回", () => {
    assert.equal(clipUtf8("abc", 100), "abc");
    assert.equal(clipUtf8("", 10), "");
  });
});
