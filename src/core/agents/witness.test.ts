import { describe, expect, it } from "vitest";
import { rewriteAppropriatedWitness } from "./witness";

const BAO = "23:05我上楼梯那会儿，白楠也在楼梯口，手里攥着手机，像是在录什么。";
const HE_CARD = "补传日志显示一张备用通行凭证23:03进入、23:08离开。23:05拦下老鲍。随白楠呼救上楼。";

describe("别人的目击不能写成自己的登记", () => {
  it("卡上没有的第一人称目击，改成转述", () => {
    const said = "23:05我拦老鲍的时候，白楠确实在楼梯口，手里攥着手机像在录什么——这个我登记了。";
    const out = rewriteAppropriatedWitness(said, HE_CARD, [{ name: "鲍长根", text: BAO }]);
    expect(out).toContain("鲍长根刚才这么说");
    expect(out).not.toContain("我登记了");
  });

  it("角色卡里本来就有的目击可以自己说", () => {
    const out = rewriteAppropriatedWitness(BAO, `${HE_CARD}\n${BAO}`, [{ name: "何大有", text: "我按登记说话。" }]);
    expect(out).toBe(BAO);
  });

  it("没有第一人称目击的句子不动", () => {
    const said = "读头只刷走廊门，不记谁攥在手里。";
    expect(rewriteAppropriatedWitness(said, HE_CARD, [{ name: "鲍长根", text: BAO }])).toBe(said);
  });
});
