import type { AssistantV2Message } from "./foldEvents";

// The panel's earlier turns of this conversation, sent with every question
// (design audit 2026-11-15, L5-07): the server keeps a conversation's thread
// in memory, and after a restart, an expired thread or one still busy it
// reads these instead (assistantV2EarlierTurns), so a follow-up keeps its
// context while the panel still shows the conversation. The last 3 finished
// answers, each with its question and its text, clipped as the server clips
// them; the server leaves out a turn the injection guard trips.
export type AssistantV2Turn = { question: string; answer: string };
type PanelTurn = { role: "user" | "assistant"; content: string; question?: string; v2?: AssistantV2Message };

export const PREVIOUS_TURNS = 3;
const QUESTION_CHARS = 300;
const ANSWER_CHARS = 800;

const answerText = (message: AssistantV2Message) => message.parts
  .map((part) => (part.kind === "text" && !part.replaced ? part.text.trim() : ""))
  .filter(Boolean)
  .join("\n\n");

export function previousTurnsOf(messages: PanelTurn[], limit = PREVIOUS_TURNS): AssistantV2Turn[] {
  return messages
    .filter((message) => message.role === "assistant" && message.question && message.v2?.done && !message.v2.error)
    .map((message) => ({ question: String(message.question).trim().slice(0, QUESTION_CHARS), answer: answerText(message.v2 as AssistantV2Message).slice(0, ANSWER_CHARS) }))
    .filter((turn) => turn.question && turn.answer)
    .slice(-limit);
}
