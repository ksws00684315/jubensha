import { describe, expect, it } from "vitest";
import { authorDesignPackageSchema, designPackageHash, validateAuthorDesignPackage } from "./design";

const pkg = authorDesignPackageSchema.parse({
  version: 1,
  experienceGoal: "让玩家在两轮讨论中完成一次证据交换",
  facts: [{ id: "f1", statement: "钟在 22:10 停摆", source: "事实账本" }],
  inferenceGraph: [{ id: "i1", premiseFactIds: ["f1"], conclusion: "停摆时间需要与证人陈述交叉验证", alternatives: ["钟本身故障"] }],
  characterPlans: [{ characterId: "alice", objectives: ["保护弟弟"], interactionHooks: ["向 bob 交换时间线"] }],
  acts: [{ actId: "act1", question: "谁能证明钟停摆前后的行动?", newKnowledge: ["钟的维修记录"], publicClueIds: ["clock"] }],
});

describe("作者设计包", () => {
  it("可稳定计算 hash，并检查正文引用", () => {
    expect(designPackageHash(pkg)).toBe(designPackageHash(pkg));
    const doc = { characters: [{ id: "alice" }], clues: [{ id: "clock" }], flow: { acts: [{ id: "act1" }] } } as never;
    expect(validateAuthorDesignPackage(pkg, doc)).toEqual([]);
    expect(validateAuthorDesignPackage({ ...pkg, acts: [{ ...pkg.acts[0], publicClueIds: ["missing"] }] }, doc).some((i) => i.level === "error")).toBe(true);
  });
});
