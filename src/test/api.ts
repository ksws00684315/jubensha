import { vi, type Mock } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

export { resetRateLimits };

/**
 * L2 API 路由测试公共夹具。
 *
 * 用法约定：
 * - `vi.mock("@/lib/db", () => ({ db: mockDbInstance }))` —— mockDbInstance 是惰性代理，
 *   `db.<model>.<method>` 首次访问时创建 vi.fn()；测试里直接
 *   `vi.mocked(db.game.findUnique).mockResolvedValue(...)` 配置与断言。
 * - 本模块必须在任何会传递性 import `@/lib/db` 的模块**之前** import（ESM 按源码顺序初始化），
 *   否则 mock 工厂执行时 mockDbInstance 尚未初始化。
 * - 需要限流的用例在 beforeEach 调 `resetRateLimits()`（本模块 re-export）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock 的调用签名本来就宽容，any 是夹具的合理形态
type AnyMock = Mock<(...args: any[]) => any>;

/** 宽松类型：任意 model.method 都是 vi.fn（惰性创建）。 */
export type MockDb = { $transaction: AnyMock } & Record<string, Record<string, AnyMock>>;

const fns = new Map<string, AnyMock>();

function fnFor(model: string, method: string): AnyMock {
  const key = `${model}.${method}`;
  let f = fns.get(key);
  if (!f) {
    f = vi.fn();
    if (model === "$tx" && method === "$transaction") {
      (f as AnyMock).mockImplementation(async (arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(mockDbInstance);
        throw new Error("$transaction: unsupported argument");
      });
    }
    fns.set(key, f);
  }
  return f;
}

function makeDbProxy(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === "$transaction") {
          // 两种形态都支持：数组形式（Promise.all）与回调形式（回调收到的 tx 即同一套 mock）。
          // 缓存在固定 key 下，保证多次访问拿到同一个 vi.fn。
          return fnFor("$tx", "$transaction");
        }
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return fnFor(model, method);
            },
          }
        );
      },
    }
  );
}

export const mockDbInstance = makeDbProxy() as MockDb;

/** 取（或创建）`db.<model>.<method>` 的 vi.fn。与 mockDbInstance 等价，仅供显式取 mock。 */
export function dbFn(model: string, method: string): AnyMock {
  return fnFor(model, method);
}

export function makeReq(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string | number> } = {}
): Request {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
  const headers = new Headers(opts.headers);
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Request(url, { method, headers, body });
}

export function ctx<P extends Record<string, string>>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789";

/** 设置测试管理口令并返回对应请求头。生产模式用例请另用 vi.stubEnv("NODE_ENV", "production")。 */
export function adminHeaders(): Record<string, string> {
  process.env.ADMIN_TOKEN = TEST_ADMIN_TOKEN;
  return { "x-admin-token": TEST_ADMIN_TOKEN };
}
