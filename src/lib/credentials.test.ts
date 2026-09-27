import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { verifyDmToken, verifyHostToken, verifySeatToken, verifyToken } from "./credentials";

const A = "kY3xvQ9mLpQ7sT2wBz8dNhRfJu4cGe6a";
const B = "kY3xvQ9mLpQ7sT2wBz8dNhRfJu4cGe6b"; // 只差最后一个字符
const SHORT = "kY3xvQ9mLpQ7sT2wBz8dNhRfJu4cGe";

describe("verifyToken（凭证比对原语）", () => {
  it("正确凭证通过", () => {
    expect(verifyToken(A, A)).toBe(true);
  });

  it("内容不同一律不匹配（含只差一个字符）", () => {
    expect(verifyToken(B, A)).toBe(false);
    expect(verifyToken(A.toLowerCase(), A)).toBe(false);
  });

  it("长度不同不匹配，且不抛错（timingSafeEqual 对长度不等的原生行为被包装掉）", () => {
    expect(verifyToken(SHORT, A)).toBe(false);
    expect(verifyToken(A, SHORT)).toBe(false);
    expect(verifyToken("", A)).toBe(false);
  });

  it("任一侧为空（null / undefined / 空串）都不算匹配，双侧皆空也不例外", () => {
    expect(verifyToken(null, A)).toBe(false);
    expect(verifyToken(undefined, A)).toBe(false);
    expect(verifyToken("", A)).toBe(false);
    expect(verifyToken(A, null)).toBe(false);
    expect(verifyToken(A, undefined)).toBe(false);
    expect(verifyToken(A, "")).toBe(false);
    expect(verifyToken(null, null)).toBe(false);
    expect(verifyToken("", "")).toBe(false);
  });

  it("走的是常量时间比较，不是字符串 ===", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    verifyToken(B, A);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("verifySeatToken", () => {
  const seats = [
    { index: 0, token: A },
    { index: 1, token: null },
    { index: 2, token: "seat2" },
  ];

  it("座位与凭证都正确才授权", () => {
    expect(verifySeatToken(seats, 0, A)).toBe(true);
    expect(verifySeatToken(seats, 2, "seat2")).toBe(true);
  });

  it("凭证错 / 空 / 缺省都拒绝", () => {
    expect(verifySeatToken(seats, 0, B)).toBe(false);
    expect(verifySeatToken(seats, 0, "")).toBe(false);
    expect(verifySeatToken(seats, 0, null)).toBe(false);
    expect(verifySeatToken(seats, 0, undefined)).toBe(false);
  });

  it("未发卡的座位（token=null）永不通过，哪怕请求侧也没带凭证", () => {
    expect(verifySeatToken(seats, 1, null)).toBe(false);
    expect(verifySeatToken(seats, 1, "")).toBe(false);
  });

  it("座位不存在、或 index 非法（null / undefined / NaN）时拒绝", () => {
    expect(verifySeatToken(seats, 7, A)).toBe(false);
    expect(verifySeatToken(seats, null, A)).toBe(false);
    expect(verifySeatToken(seats, undefined, A)).toBe(false);
    expect(verifySeatToken(seats, Number("x"), A)).toBe(false);
  });

  it("拿 A 座位的凭证去认 B 座位不通过（凭证不跨座位通用）", () => {
    expect(verifySeatToken(seats, 2, A)).toBe(false);
  });
});

describe("verifyDmToken / verifyHostToken", () => {
  it("未认领（stored 为 null）时任何凭证都不通过", () => {
    expect(verifyDmToken({ dmToken: null }, A)).toBe(false);
    expect(verifyHostToken({ hostToken: null }, A)).toBe(false);
    expect(verifyDmToken({ dmToken: null }, null)).toBe(false);
    expect(verifyHostToken({ hostToken: null }, "")).toBe(false);
  });

  it("正确通过、错误拒绝", () => {
    expect(verifyDmToken({ dmToken: A }, A)).toBe(true);
    expect(verifyDmToken({ dmToken: A }, B)).toBe(false);
    expect(verifyHostToken({ hostToken: A }, A)).toBe(true);
    expect(verifyHostToken({ hostToken: A }, SHORT)).toBe(false);
  });
});
