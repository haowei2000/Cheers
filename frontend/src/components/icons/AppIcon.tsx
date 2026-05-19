import type { LucideIcon, LucideProps } from "lucide-react";
import {
  Archive,
  ArrowLeft,
  Bell,
  Bot,
  Brain,
  Briefcase,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Folder,
  Forward,
  Hash,
  HelpCircle,
  Image,
  KeyRound,
  LayoutDashboard,
  Link,
  Lock,
  LockKeyhole,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquare,
  Minus,
  MoreHorizontal,
  NotebookTabs,
  Paperclip,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  UploadCloud,
  User,
  UserPlus,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";

export const appIconMap = {
  admin: Shield,
  announcement: Megaphone,
  archive: Archive,
  arrowLeft: ArrowLeft,
  attachment: Paperclip,
  bot: Bot,
  briefcase: Briefcase,
  channel: Hash,
  check: Check,
  checkCircle: CheckCircle2,
  clock: Clock,
  close: X,
  copy: Copy,
  dashboard: LayoutDashboard,
  database: Database,
  download: Download,
  externalLink: ExternalLink,
  file: FileText,
  folder: Folder,
  forward: Forward,
  help: HelpCircle,
  image: Image,
  key: KeyRound,
  link: Link,
  lock: Lock,
  secure: LockKeyhole,
  members: Users,
  memory: Brain,
  menu: Menu,
  message: MessageSquare,
  messageCircle: MessageCircle,
  minus: Minus,
  more: MoreHorizontal,
  model: Cpu,
  note: NotebookTabs,
  notification: Bell,
  palette: Palette,
  pencil: Pencil,
  plus: Plus,
  preview: Eye,
  refresh: RefreshCw,
  reply: Reply,
  search: Search,
  send: Send,
  settings: Settings,
  sliders: SlidersHorizontal,
  shieldCheck: ShieldCheck,
  task: ClipboardList,
  tools: Wrench,
  trash: Trash2,
  trending: TrendingUp,
  upload: UploadCloud,
  user: User,
  userPlus: UserPlus,
  users: Users,
  zap: Zap,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
} satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof appIconMap;

export interface AppIconProps extends LucideProps {
  fallback?: AppIconName;
  name: AppIconName;
}

export function AppIcon({
  absoluteStrokeWidth = true,
  fallback = "file",
  name,
  strokeWidth = 1.85,
  ...props
}: AppIconProps) {
  const Icon = appIconMap[name] ?? appIconMap[fallback];
  const ariaLabel = props["aria-label"];

  return (
    <Icon
      aria-hidden={ariaLabel ? undefined : true}
      data-app-icon=""
      focusable="false"
      absoluteStrokeWidth={absoluteStrokeWidth}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
}
