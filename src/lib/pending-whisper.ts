export const PENDING_WHISPER_DELAY_MS = 3000;

export type PendingWhisper = {
  text: string;
  dueAt: number;
  sending?: boolean;
  failed?: boolean;
};

export function createPendingWhisper(text: string, now: number): PendingWhisper {
  return { text, dueAt: now + PENDING_WHISPER_DELAY_MS };
}

export function editPendingWhisper(pending: PendingWhisper, text: string, now: number): PendingWhisper {
  return { text, dueAt: now + PENDING_WHISPER_DELAY_MS };
}

export function retryPendingWhisper(pending: PendingWhisper, now: number): PendingWhisper {
  return { text: pending.text, dueAt: now + PENDING_WHISPER_DELAY_MS };
}

export function isPendingWhisperDue(pending: PendingWhisper, now: number): boolean {
  return !pending.sending && !pending.failed && pending.dueAt <= now;
}

export function applyPendingWhisperResult(pending: PendingWhisper, sent: boolean): PendingWhisper | null {
  return sent ? null : { text: pending.text, dueAt: pending.dueAt, failed: true };
}
