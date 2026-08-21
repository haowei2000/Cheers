import { defineRenderer } from "@haowei0520/cheers-workbench-sdk";

defineRenderer<{ label: string; sourceText: string }>({
  toContext(target) {
    return target;
  },
  activate(ctx) {
    const editor = document.createElement("textarea");
    document.querySelector("#root")?.append(editor);
    ctx.file.onRender((file) => { editor.value = file.content; });
    const save = () => void ctx.file.save(editor.value);
    const pick = (event: MouseEvent) => {
      const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      ctx.context.pick(event, { label: selected ? "Selected notes" : "Notes", sourceText: selected || editor.value });
    };
    editor.addEventListener("change", save);
    editor.addEventListener("contextmenu", pick);
    return () => {
      editor.removeEventListener("change", save);
      editor.removeEventListener("contextmenu", pick);
    };
  },
});
