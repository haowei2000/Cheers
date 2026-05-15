import type { LucideIcon, LucideProps } from "lucide-react";
import {
  Bell,
  Bot,
  Brain,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  FileText,
  Folder,
  Hash,
  Image,
  KeyRound,
  LayoutDashboard,
  Lock,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  Shield,
  Trash2,
  User,
  Users,
  Wrench,
  X,
} from "lucide-react";

export const appIconMap = {
  admin: Shield,
  attachment: Paperclip,
  bot: Bot,
  channel: Hash,
  close: X,
  copy: Copy,
  dashboard: LayoutDashboard,
  database: Database,
  download: Download,
  file: FileText,
  folder: Folder,
  image: Image,
  key: KeyRound,
  lock: Lock,
  members: Users,
  memory: Brain,
  menu: Menu,
  message: MessageSquare,
  model: Cpu,
  notification: Bell,
  plus: Plus,
  preview: Eye,
  refresh: RefreshCw,
  reply: Reply,
  search: Search,
  send: Send,
  settings: Settings,
  task: ClipboardList,
  tools: Wrench,
  trash: Trash2,
  user: User,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
} satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof appIconMap;

export interface AppIconProps extends LucideProps {
  fallback?: AppIconName;
  name: AppIconName;
}

export function AppIcon({ fallback = "file", name, ...props }: AppIconProps) {
  const Icon = appIconMap[name] ?? appIconMap[fallback];
  const ariaLabel = props["aria-label"];

  return <Icon aria-hidden={ariaLabel ? undefined : true} {...props} />;
}
