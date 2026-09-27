/**
 * Next 服务实例启动时的一次性挂载点（S4.1 引入）。
 *
 * 目前只挂一件事：进程收到退出信号（SIGTERM；生产环境另含 pm2 默认发的 SIGINT）时，
 * 先把它持有的写租约交回数据库再退出。
 * 不这么做的话，接管方要空等一整个租期（30s）才能重新驱动那些对局。
 *
 * `register` 在所有运行时都会被调用，租约是 Node 侧的事，所以只在 nodejs 运行时导入。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installLeaseReleaseOnSignal } = await import("./core/engine/lease");
  installLeaseReleaseOnSignal();
}
