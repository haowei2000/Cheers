import { defineRenderer } from "@haowei0520/cheers-workbench-sdk";

defineRenderer<{ label: string; sourceText: string }>({
  toContext(target) {
    return target;
  },
  activate(ctx) {
    const editor = document.createElement("textarea");
    editor.setAttribute("aria-label", "Shared Markdown notes");
    editor.spellcheck = true;
    document.querySelector("#root")?.append(editor);

    let rendered = "";
    ctx.file.onRender((file) => {
      rendered = file.content;
      if (document.activeElement !== editor) editor.value = file.content;
    });

    const save = () => {
      if (editor.value !== rendered) void ctx.file.save(editor.value);
    };
    const pick = (event: MouseEvent) => {
      const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      ctx.context.pick(event, {
        label: selected ? "Selected notes" : "Open questions",
        sourceText: selected || rendered,
      });
    };
    editor.addEventListener("change", save);
    editor.addEventListener("contextmenu", pick);

    return () => {
      editor.removeEventListener("change", save);
      editor.removeEventListener("contextmenu", pick);
    };
  },
});
