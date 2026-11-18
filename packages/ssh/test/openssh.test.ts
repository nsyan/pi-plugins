import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSftpLongNames } from "../src/transports/openssh.js";

describe("parseSftpLongNames", () => {
  it("解出名字、字节数和目录标志", () => {
    const out = [
      "total 24",
      "-rw-r--r--    1 deploy   deploy        512 Nov 18 10:00 app.jar",
      "drwxr-xr-x    3 deploy   deploy       4096 Nov 18 09:00 logs",
      "-rwxr-xr-x    1 deploy   deploy          0 Nov 18 09:00 run.sh",
    ].join("\n");
    assert.deepEqual(parseSftpLongNames(out), [
      { name: "app.jar", size: 512, directory: false },
      { name: "logs", size: 4096, directory: true },
      { name: "run.sh", size: 0, directory: false },
    ]);
  });

  it("名字里有空格不会被切断", () => {
    const out = "-rw-r--r--    1 deploy   deploy         17 Nov 18 10:00 my report 2026.txt";
    assert.deepEqual(parseSftpLongNames(out), [{ name: "my report 2026.txt", size: 17, directory: false }]);
  });

  it("丢掉 total 行和 . / ..", () => {
    const out = [
      "total 8",
      "drwxr-xr-x    2 deploy   deploy       4096 Nov 18 10:00 .",
      "drwxr-xr-x    5 deploy   deploy       4096 Nov 18 09:00 ..",
      "-rw-r--r--    1 deploy   deploy          3 Nov 18 10:00 a.txt",
    ].join("\n");
    assert.deepEqual(parseSftpLongNames(out), [{ name: "a.txt", size: 3, directory: false }]);
  });

  it("空输出不给结果", () => {
    assert.deepEqual(parseSftpLongNames(""), []);
  });
});
