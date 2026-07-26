export type AiInsight = {
  type: "risk" | "opportunity" | "info" | "action";
  title: string;
  body: string;
  metric?: string;
};

// Insights must be returned by an authoritative API with evidence.
export const AI_INSIGHTS: Record<string, AiInsight[]> = {};
