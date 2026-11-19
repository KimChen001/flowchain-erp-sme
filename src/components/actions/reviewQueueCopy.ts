// The review queue's draft statuses. The server sends a stable code
// (REVIEW_DRAFT_STATUSES in server/domain/review-first-action-workflow-v2.mjs);
// the page names it in the interface language, English first, rather than
// showing a Chinese status word stored as the value (design audit L6-20).
// Each entry is [English, Chinese].
export const REVIEW_STATUS_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  draft_preview: ["Draft preview", "草稿预览"],
  awaiting_review: ["Awaiting human review", "等待人工复核"],
  needs_information: ["More information needed", "需要补充信息"],
  returned: ["Returned for review", "已退回复核"],
  cancelled: ["Cancelled", "已取消"],
  handled_manually: ["Marked as handled manually", "已标记人工处理"],
};

// The button that moves a draft to a status.
export const REVIEW_TRANSITION_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  draft_preview: ["Back to draft preview", "草稿预览"],
  awaiting_review: ["Send to human review", "标记进入人工复核"],
  needs_information: ["Ask for more information", "要求补充信息"],
  returned: ["Return for review", "退回复核"],
  cancelled: ["Cancel draft", "取消草稿"],
  handled_manually: ["Mark as handled manually", "标记人工处理"],
};

const pick = (entry: readonly [string, string] | undefined, code: string, language: string) => entry ? entry[language === "zh-CN" ? 1 : 0] : code;

export function reviewStatusLabel(code: string, language: string) {
  return pick(REVIEW_STATUS_LABELS[code], code, language);
}

export function reviewTransitionLabel(code: string, language: string) {
  return pick(REVIEW_TRANSITION_LABELS[code], code, language);
}
