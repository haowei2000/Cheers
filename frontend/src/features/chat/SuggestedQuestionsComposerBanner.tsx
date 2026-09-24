/** @file Composer banner showing switchable suggested questions for the active bot turn. */

import { Button as UiButton } from "@/components/ui/button";
import { Sparkles, X } from "lucide-react";
import {
  formatSuggestionDisplayText,
  type SuggestedQuestion,
} from "./suggestedQuestions";

interface Props {
  questions: SuggestedQuestion[];
  selectedIndex?: number;
  onSelect: (question: SuggestedQuestion, index: number) => void;
  onDismiss: () => void;
}

export function SuggestedQuestionsComposerBanner({
  questions,
  selectedIndex,
  onSelect,
  onDismiss,
}: Props) {
  if (questions.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[72rem] px-4 pt-2 max-md:px-3">
      <div
        className="flex items-center gap-2 rounded-sm bg-panel border-l-2 border-l-content-strong/60 px-3 py-1 shadow-2xs"
        role="region"
        aria-label="Suggested questions"
      >
        <span
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm bg-control text-content-strong"
          title="Suggested questions"
          aria-hidden="true"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div
          className="flex flex-1 items-center gap-2 overflow-x-auto py-1 no-scrollbar"
          role="group"
          aria-label="Recommended questions"
        >
          {questions.map((question, index) => {
            const isSelected = selectedIndex === index;
            const displayText = formatSuggestionDisplayText(question.text);
            return (
              <UiButton
                key={`${index}:${question.text}`}
                variant="secondary"
                content="text"
                controlSize="compact"
                controlWidth="content"
                role="option"
                selected={isSelected}
                type="button"
                onClick={() => onSelect(question, index)}
                className="truncate max-w-[320px] shrink-0"
                title={displayText}
              >
                {displayText}
              </UiButton>
            );
          })}
        </div>
        <UiButton
          action="dismiss"
          variant="plain"
          type="button"
          onClick={onDismiss}
          content="icon"
          controlSize="compact"
          aria-label="Dismiss suggestions"
          title="Dismiss suggestions"
        >
          <X className="h-3.5 w-3.5" />
        </UiButton>
      </div>
    </div>
  );
}
