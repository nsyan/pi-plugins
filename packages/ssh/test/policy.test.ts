import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, decide, type Policy, type PolicyHost, type SessionGrant } from "../src/core/policy.js";

const host: PolicyHost = { id: "web" };
const prod: PolicyHost = { id: "web", tags: ["prod"] };
const policy = (confirm: Policy["confirm"], readonly = false): Policy => ({ confirm, readonly });

describe("classify 命中表", () => {
  const destructive: Array<[string, string]> = [
    ["rm -rf /tmp/x", "删除文件或目录"],
    ["rm -f a", "删除文件或目录"],
    ["docker rm -f hsybp-sjzt-web", "删除容器或镜像"],
    ["docker rmi nginx", "删除容器或镜像"],
    ["docker system prune -f", "清理 Docker 资源"],
    ["systemctl stop nginx", "停止、禁用或屏蔽服务"],
    ["systemctl disable nginx", "停止、禁用或屏蔽服务"],
    ["systemctl mask nginx", "停止、禁用或屏蔽服务"],
    ["mkfs.ext4 /dev/sdb", "格式化磁盘"],
    ["dd if=/dev/zero of=/dev/sdb", "dd 写入设备或文件"],
    ["echo x > /etc/hosts", "覆盖 /etc 或 /boot 下的文件"],
    ["echo x>/boot/vmlinuz", "覆盖 /etc 或 /boot 下的文件"],
    ["git reset --hard", "丢弃未提交的本地修改"],
    ["git clean -fd", "删除未跟踪文件"],
    ["kill -9 123", "强制杀死进程"],
    ["reboot", "关闭或重启机器"],
    ["shutdown -h now", "关闭或重启机器"],
    ["halt", "关闭或重启机器"],
    ["userdel bob", "删除用户或用户组"],
    ["groupdel bob", "删除用户或用户组"],
    ["iptables -F", "清空防火墙规则"],
    ["chmod -R 777 /", "递归放开全部权限"],
    ["chmod -R 0777 /srv", "递归放开全部权限"],
    [":(){ :|:& };:", "fork 炸弹"],
    ["find /tmp -name '*.log' -delete", "find 删除匹配文件"],
  ];
  for (const [command, summary] of destructive) {
    it(`destructive: ${command}`, () => {
      assert.deepEqual(classify(command), { danger: "destructive", summary });
    });
  }

  const write: Array<[string, string]> = [
    ["sed -i 's/a/b/' env.sh", "原地修改文件"],
    ["mv a b", "移动、复制或修改文件"],
    ["cp a b", "移动、复制或修改文件"],
    ["chmod 644 env.sh", "移动、复制或修改文件"],
    ["chown deploy env.sh", "移动、复制或修改文件"],
    ["tee /tmp/out", "移动、复制或修改文件"],
    ["truncate -s 0 app.log", "移动、复制或修改文件"],
    // 回归：这四条曾被漏判为 read，只读模式下直接放行（实测 mkdir 能执行成功）
    ["mkdir -p /tmp/x", "创建目录"],
    ["mkdir x", "创建目录"],
    ["touch /tmp/a", "创建或更新时间戳"],
    ["ln -s a b", "创建链接"],
    ["git checkout -- .", "用 git checkout 覆盖工作区文件"],
    ["git checkout -- file.txt", "用 git checkout 覆盖工作区文件"],
    ["systemctl restart app", "重启或设置服务开机启动"],
    ["systemctl reload nginx", "重启或设置服务开机启动"],
    ["systemctl enable app", "重启或设置服务开机启动"],
    ["docker run -d nginx", "启动、停止或重启容器"],
    ["docker stop web", "启动、停止或重启容器"],
    ["docker restart web", "启动、停止或重启容器"],
    ["docker compose up -d", "变更 compose 项目"],
    ["docker-compose down", "变更 compose 项目"],
    ["apt-get install -y openjdk-21-jre-headless", "安装或卸载软件包"],
    ["apt remove nginx", "安装或卸载软件包"],
    ["echo a > /tmp/x", "把输出写入文件"],
  ];
  for (const [command, summary] of write) {
    it(`write: ${command}`, () => {
      assert.deepEqual(classify(command), { danger: "write", summary });
    });
  }

  for (const command of ["ls -la", "df -h", "systemctl status nginx", "docker ps", "cat /etc/hosts", "ls 2>/dev/null", "ls 2>&1", "rm --help"]) {
    it(`read: ${command}`, () => {
      assert.equal(classify(command).danger, "read");
    });
  }
});

describe("classify 混淆绕过不能当成只读", () => {
  for (const command of [
    'bash -c "rm -rf /tmp/a"',
    "sh -c 'systemctl stop nginx'",
    "echo $(rm -rf /var)",
    "base64 -d payload | bash",
    "eval $(cat /tmp/next)",
  ]) {
    it(command, () => {
      assert.notEqual(classify(command).danger, "read");
    });
  }
});

describe("decide", () => {
  const read = classify("ls");
  const write = classify("sed -i 's/a/b/' env.sh");
  const destructive = classify("rm -rf /tmp/x");
  const grant: SessionGrant = { hostId: "web", untilMs: 2_000 };

  it("只读模式拒绝写和破坏，放行只读", () => {
    assert.equal(decide(read, policy("destructive", true), host), "run");
    assert.equal(decide(write, policy("destructive", true), host), "deny");
    assert.equal(decide(destructive, policy("write", true), host), "deny");
  });

  it("默认只确认 destructive", () => {
    assert.equal(decide(read, policy("destructive"), host), "run");
    assert.equal(decide(write, policy("destructive"), host), "run");
    assert.equal(decide(destructive, policy("destructive"), host), "confirm");
  });

  it("write 级别连写操作一起确认，always 连只读也确认", () => {
    assert.equal(decide(write, policy("write"), host), "confirm");
    assert.equal(decide(destructive, policy("write"), host), "confirm");
    assert.equal(decide(read, policy("always"), host), "confirm");
  });

  it("生产主机的写操作不能被级别或会话授权放宽", () => {
    assert.equal(decide(write, policy("destructive"), prod), "confirm");
    assert.equal(decide(write, policy("destructive"), prod, grant, 1_000), "confirm");
    assert.equal(decide(read, policy("destructive"), prod), "run");
  });

  it("非生产主机的有效授权只跳过 write，destructive 仍要确认", () => {
    assert.equal(decide(write, policy("write"), host, grant, 1_000), "run");
    assert.equal(decide(destructive, policy("destructive"), host, grant, 1_000), "confirm");
    assert.equal(decide(write, policy("write"), host, grant, 2_000), "confirm");
    assert.equal(decide(write, policy("write"), host, { hostId: "other", untilMs: 9_000 }, 1_000), "confirm");
  });
});
