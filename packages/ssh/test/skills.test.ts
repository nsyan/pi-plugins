// skills.test.ts —— 用 pi 自己的 loader 校验随包发布的 skills，防止缺 description 被静默丢弃。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));

describe("打包的 skills", () => {
  // 用 pi 自己的 loader：缺 description 的 SKILL.md 只会得一条 warning 诊断而被丢弃（不抛错），
  // 所以「静默失效」只能靠这里的断言拦住。
  const loaded = loadSkillsFromDir({ dir: skillsDir, source: "path" });

  it("deploy 能被 pi 加载且无诊断", () => {
    assert.deepEqual(
      loaded.skills.map((skill) => skill.name),
      ["deploy"],
      "缺 description 的 SKILL.md 会被 loader 丢弃（不报错），这里必须能加载到",
    );
    assert.deepEqual(loaded.diagnostics, []);
  });

  it("description 写清用途与触发场景，够模型路由", () => {
    for (const skill of loaded.skills) {
      assert.ok(skill.description.trim().length >= 30, `${skill.name} 的 description 太短，无法用于路由`);
      assert.match(skill.description, /当.*时|时使用|时用/u, `${skill.name} 的 description 应写明何时使用`);
    }
  });
});
