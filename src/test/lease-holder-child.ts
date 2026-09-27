import { INSTANCE_ID, acquireLease, installLeaseReleaseOnSignal, startLeaseRenewal } from "@/core/engine/lease";
import { resolveDatabaseUrl } from "@/lib/app-config";

/**
 * S4.1 验收 4 的被测进程：一个真·另一实例。
 * 取走指定对局的写租约后常驻，等父进程发 SIGTERM，验证「退出前 1s 内交牌」。
 * 只由 `lease.int.test.ts` 用 tsx 拉起；输出行不含任何凭证。
 */

// 与 L3 助手同一道保险：连接串必须指向测试库，否则不碰数据库。
process.env.APP_CONFIG_PATH ??= "/nonexistent/lease-holder-child.json";
const url = resolveDatabaseUrl().url ?? "";
if (!url.endsWith("/jubensha_test")) {
  console.error("REFUSED 只允许连接 jubensha_test");
  process.exit(2);
}

const gameId = process.argv[2];
if (!gameId) {
  console.error("用法：lease-holder-child <gameId>");
  process.exit(2);
}

async function main(): Promise<void> {
  installLeaseReleaseOnSignal();
  console.log(`ACQUIRED ${await acquireLease(gameId, INSTANCE_ID)}`);
  console.log(`HOLDER ${INSTANCE_ID}`);
  startLeaseRenewal(gameId, () => console.log("LOST"));
  // 续租定时器是 unref 的，本进程需要一个真句柄才能活到 SIGTERM
  setInterval(() => undefined, 5_000);
  console.log("READY");
}

void main();
