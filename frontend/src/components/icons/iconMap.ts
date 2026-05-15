import { AiBrandIcon, aiBrandIconMap } from "./AiBrandIcon";
import { AppIcon, appIconMap } from "./AppIcon";
import { BrandIcon, brandIconMap } from "./BrandIcon";
import { FileTypeIcon } from "./FileTypeIcon";
import { OtherIcon, otherIconMap } from "./OtherIcon";

export const iconMap = {
  aiBrand: aiBrandIconMap,
  brand: brandIconMap,
  fileType: "react-file-icon",
  main: appIconMap,
  other: otherIconMap,
} as const;

export const iconComponents = {
  aiBrand: AiBrandIcon,
  brand: BrandIcon,
  fileType: FileTypeIcon,
  main: AppIcon,
  other: OtherIcon,
} as const;

export const iconLibraryGuide = {
  main: {
    component: "AppIcon",
    library: "lucide-react",
    priority: "required",
    status: "installed",
    usage: "Core UI: channels, messages, send, search, settings, notifications, attachments, bots, users, memory, admin.",
  },
  aiBrand: {
    component: "AiBrandIcon",
    library: "@lobehub/icons",
    priority: "required",
    status: "installed",
    usage: "AI and LLM providers: OpenAI, Claude, Anthropic, Gemini, DeepSeek, Mistral, Qwen, Ollama, Hugging Face.",
  },
  fileType: {
    component: "FileTypeIcon",
    library: "react-file-icon",
    priority: "required",
    status: "installed",
    usage: "Chat attachments and file previews: PDF, DOCX, XLSX, PPTX, PNG, ZIP, Markdown, JavaScript, and similar files.",
  },
  other: {
    component: "OtherIcon",
    library: "simple-icons",
    priority: "optional",
    status: "installed",
    usage: "General brand and technology logos such as GitHub, Docker, Google, Slack, Microsoft, AWS, and future non-core icon families.",
  },
  officeFile: {
    component: null,
    library: "@fluentui/react-file-type-icons",
    priority: "optional",
    status: "not-installed",
    usage: "Optional enterprise Office-style Word, Excel, PowerPoint, and SharePoint document icons.",
  },
  codeFile: {
    component: null,
    library: "material-icon-theme or vscode-icons-js",
    priority: "optional",
    status: "not-installed",
    usage: "Optional code repository file trees, package previews, and configuration file recognition.",
  },
  extended: {
    component: null,
    library: "@tabler/icons-react",
    priority: "optional",
    status: "not-installed",
    usage: "Optional specialized workflow, database, deployment, model, and dashboard icons not covered by Lucide.",
  },
  compact: {
    component: null,
    library: "@radix-ui/react-icons",
    priority: "optional",
    status: "not-installed",
    usage: "Optional compact admin icons for dense buttons, menus, and table actions.",
  },
  fallback: {
    component: null,
    library: "@iconify/react",
    priority: "fallback",
    status: "not-installed",
    usage: "Prototype-only fallback for rare icons; avoid making it a core runtime dependency.",
  },
} as const;

export type IconCategory = keyof typeof iconComponents;
export type IconLibraryCategory = keyof typeof iconLibraryGuide;
