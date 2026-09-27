import type { GameState } from "./types";

interface SpeechFailureEngine {
  state: Pick<GameState, "phase" | "round">;
  speakerName(seat: number): string;
  systemSay(text: string): Promise<void>;
}

const reportedByEngine = new WeakMap<object, Set<string>>();

/** Keep repeated AI failures with the same cause to one public notice per phase and round. */
export async function reportSpeechFailure(
  engine: SpeechFailureEngine,
  seat: number,
  reason: string,
): Promise<boolean> {
  const key = `${engine.state.phase}:${engine.state.round}:${reason}`;
  let reported = reportedByEngine.get(engine);
  if (!reported) {
    reported = new Set();
    reportedByEngine.set(engine, reported);
  }
  if (reported.has(key)) return false;
  reported.add(key);
  await engine.systemSay(`（AI 玩家「${engine.speakerName(seat)}」思考时遇到问题：${reason}。场内玩家可稍作等待或继续。）`);
  return true;
}
