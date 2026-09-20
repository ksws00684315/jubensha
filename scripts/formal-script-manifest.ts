/**
 * 可同步到正式库的剧本白名单。
 *
 * 不从目录推断正式内容：试玩样本与未来的编辑草稿可能同样是 JSON，
 * 只能通过这里的显式登记进入生产同步。
 */
export const FORMAL_SCRIPT_FILES = [
  "seeds/05p-haigou7.json",
  "seeds/06p-jiyetekuai.json",
  "seeds/06p-yanguilou.json",
  "seeds/sample-5p-cloudlanshan.json",
  "seeds/generated/05p-xuexiangyehua.json",
  "seeds/generated/05p-yehanghao.json",
  "seeds/generated/06p-hongyanbanhang.json",
  "seeds/generated/06p-huangmoyingdi.json",
  "seeds/generated/06p-jiamianwenquan.json",
  "seeds/generated/06p-tianchixuehui.json",
  "seeds/generated/06p-weicanglaike.json",
  "seeds/generated/4p-huoguoju.json",
  "seeds/generated/4p-shenyeshitang.json",
  "seeds/generated/5p-baoguanfengyun.json",
  "seeds/generated/5p-bianjibu.json",
  "seeds/generated/5p-diqifengheka.json",
  "seeds/generated/5p-jiuyinglou.json",
  "seeds/generated/5p-jueshengju.json",
  "seeds/generated/5p-shoulingyiyun.json",
  "seeds/generated/5p-shuyuanjinglei.json",
  "seeds/generated/5p-wuyediantai.json",
  "seeds/generated/5p-xiufushi.json",
  "seeds/generated/6p-caipaizhiye.json",
  "seeds/generated/6p-caoyunfengyun.json",
  "seeds/generated/6p-chamagudao.json",
  "seeds/generated/6p-chuwangzhengba.json",
  "seeds/generated/6p-citangyeji.json",
  "seeds/generated/6p-kechangyiyun.json",
  "seeds/generated/6p-luocuizhiqian.json",
  "seeds/generated/6p-shangyuandengying.json",
  "seeds/generated/6p-wuoxixiban.json",
  "seeds/generated/6p-zuihouyizhiwu.json",
  "seeds/generated/7p-nanyanchuanpiao.json",
  "seeds/generated/7p-wangfunianyan.json",
] as const;

/** 仅在显式传入 --include-demos 时同步，用于答题流程回归。 */
export const DEMO_SCRIPT_FILES = ["seeds/generated/sample-4p-quiz.json"] as const;
