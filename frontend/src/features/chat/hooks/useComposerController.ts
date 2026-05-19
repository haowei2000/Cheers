import { useCallback, useRef, useState } from "react";
import {
  MESSAGE_COMPOSER_KIND_ORDER,
  type MessageComposerKind,
} from "../../../components/MessageComposer";
import type { Message } from "../../../types";

type MsgKind = MessageComposerKind;

type ResetComposerAfterSendOptions = {
  nextInput?: string;
};

export function useComposerController() {
  const [msgKind, setMsgKind] = useState<MsgKind>("normal");
  const [composerTitle, setComposerTitle] = useState("");
  const composerTitleRef = useRef<HTMLInputElement | null>(null);
  const [input, setInput] = useState("");
  const [inputRevision, setInputRevision] = useState(0);
  const inputDraftRef = useRef("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const secretInputRef = useRef<HTMLInputElement | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const secretMode = msgKind === "secret";

  const setComposerInput = useCallback((value: string) => {
    inputDraftRef.current = value;
    setInput(value);
    setInputRevision((revision) => revision + 1);
  }, []);

  const handleComposerValueChange = useCallback((value: string) => {
    inputDraftRef.current = value;
  }, []);

  const cycleMsgKind = useCallback((direction: 1 | -1) => {
    setMsgKind((prev) => {
      const idx = MESSAGE_COMPOSER_KIND_ORDER.indexOf(prev);
      const next =
        (idx + direction + MESSAGE_COMPOSER_KIND_ORDER.length) %
        MESSAGE_COMPOSER_KIND_ORDER.length;
      setComposerTitle("");
      return MESSAGE_COMPOSER_KIND_ORDER[next];
    });
  }, []);

  const resetComposerAfterSend = useCallback(
    (options?: ResetComposerAfterSendOptions) => {
      setComposerInput(options?.nextInput ?? "");
      setMsgKind("normal");
      setComposerTitle("");
      setReplyingTo(null);
    },
    [setComposerInput],
  );

  return {
    input,
    inputRevision,
    inputDraftRef,
    inputRef,
    secretInputRef,
    setComposerInput,
    handleComposerValueChange,
    msgKind,
    setMsgKind,
    cycleMsgKind,
    composerTitle,
    setComposerTitle,
    composerTitleRef,
    replyingTo,
    setReplyingTo,
    secretMode,
    resetComposerAfterSend,
  };
}
