/** 第一人称目击或登记。用来抓住「把别人的话说成我看见的」。 */
const WITNESS = /我(?:亲眼|确实|刚才)?(?:看见|看到|瞧见|登记|记下|记录)/;

function compact(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "");
}

function longestCommon(a: string, b: string): string {
  const x = compact(a);
  const y = compact(b);
  let best = "";
  const rows = x.length + 1;
  const cols = y.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      if (x[i - 1] !== y[j - 1]) continue;
      dp[i][j] = dp[i - 1][j - 1] + 1;
      if (dp[i][j] > best.length) best = x.slice(i - dp[i][j], i);
    }
  }
  return best;
}

/**
 * 句子用「我看见 / 我登记」复述了别人的发言，而这句话又不在自己的角色卡、时间线或已公开线索里。
 * 只改这一句，保留其余发言。
 */
export function rewriteAppropriatedWitness(
  text: string,
  ownCorpus: string,
  others: Array<{ name: string; text: string }>,
): string {
  const own = compact(ownCorpus);
  return text
    .split(/(?<=[。！？])/)
    .map((sentence) => {
      if (!WITNESS.test(sentence)) return sentence;
      let hit: { name: string; span: string } | null = null;
      for (const other of others) {
        const span = longestCommon(sentence, other.text);
        if (span.length < 8 || own.includes(span)) continue;
        if (!hit || span.length > hit.span.length) hit = { name: other.name, span };
      }
      if (!hit) return sentence;
      return `${hit.name}刚才这么说。我没有亲眼看见，也不能记成我自己的登记。`;
    })
    .join("");
}
