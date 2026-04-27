export type ClarifyOption = {
  id: string;
  label: string;
  requires_text?: boolean;
  text_placeholder?: string;
};

export type ClarifyQuestion = {
  id: string;
  prompt: string;
  allow_multiple?: boolean;
  options: ClarifyOption[];
  other_enabled?: boolean;
  other_label?: string;
  other_placeholder?: string;
};

export type ClarifySchema = {
  title?: string;
  questions: ClarifyQuestion[];
  skip_policy?: "allow" | "forbid";
  reason?: string;
};

export type ClarifyAnswers = {
  selected: Record<string, string[]>;
  other_text: Record<string, string>;
  option_text?: Record<string, string>;
};

export const OTHER_CHOICE_ID = "__other__";
