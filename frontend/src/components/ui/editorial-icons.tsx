import type { ReactNode, SVGProps } from "react";

export const editorialIconNames = [
  "correspondence",
  "reply",
  "thread",
  "section",
  "edition",
  "editorialDesk",
  "excerpt",
  "attachment",
  "proof",
  "approvalSeal",
  "dispatch",
  "archive",
  "agentMark",
  "session",
  "taskDocket",
  "diffProof",
] as const;

export type EditorialIconName = (typeof editorialIconNames)[number];

const iconArtwork: Record<EditorialIconName, ReactNode> = {
  correspondence: (
    <>
      <path d="M3.75 6.5h16.5v11H3.75z" />
      <path d="m4.5 7.25 7.5 5.5 7.5-5.5" />
    </>
  ),
  reply: (
    <path d="M20 18.5c-2.25-5-5.75-7-11-7H4.5M9 6.5l-5 5 5 5" />
  ),
  thread: (
    <>
      <path d="M4.5 5.5H8c2.5 0 4 1.5 4 4v5c0 2.5 1.5 4 4 4h3.5" />
      <path d="M4.5 18.5H8c2.5 0 4-1.5 4-4v-5c0-2.5 1.5-4 4-4h3.5" />
    </>
  ),
  section: (
    <>
      <path d="M4 5h16M5.5 9v10M10 9v10M14.5 9v10M19 9v10" />
      <path d="M5.5 9h13.5" />
    </>
  ),
  edition: (
    <>
      <path d="M6 4h12v15H7.5A1.5 1.5 0 0 1 6 17.5z" />
      <path d="M6 4v13.5a1.5 1.5 0 0 1-3 0V7h3M9 8h6M9 12h6" />
    </>
  ),
  editorialDesk: (
    <>
      <path d="M3 11h18M5 11v9M19 11v9" />
      <path d="m8 11 1.5-6h5L16 11" />
    </>
  ),
  excerpt: (
    <>
      <path d="M8 5H5v3M16 5h3v3M19 16v3h-3M8 19H5v-3" />
      <path d="M8.5 10h7M8.5 14h5" />
    </>
  ),
  attachment: <path d="m8.5 12.5 5.75-5.75a3 3 0 0 1 4.25 4.25l-7.25 7.25a4.5 4.5 0 0 1-6.36-6.36l7-7" />,
  proof: <path d="M5 18 12 6l7 12M8 18h8" />,
  approvalSeal: (
    <>
      <circle cx="12" cy="10.5" r="6" />
      <path d="m8.5 16-1 5 4.5-2 4.5 2-1-5M9.25 10.5l1.75 1.75 3.75-4" />
    </>
  ),
  dispatch: <path d="m3.5 5 17 7-17 7 3-7zm3 7h8" />,
  archive: (
    <>
      <path d="M4 8h16v12H4zM3 4h18v4H3z" />
      <path d="M9 12h6" />
    </>
  ),
  agentMark: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.75 5.75 10 10M14 14l4.25 4.25M18.25 5.75 14 10M10 14l-4.25 4.25" />
    </>
  ),
  session: (
    <>
      <path d="M7 4h10M7 20h10M8 4c0 4 1.5 6.25 4 8-2.5 1.75-4 4-4 8M16 4c0 4-1.5 6.25-4 8 2.5 1.75 4 4 4 8" />
    </>
  ),
  taskDocket: (
    <>
      <path d="M7 5h10v15H7zM9 5V3h6v2" />
      <path d="m9.5 12 1.75 1.75L15 9.5" />
    </>
  ),
  diffProof: (
    <>
      <path d="M12 4v16M4 8h6M7 5v6M14 8h6" />
      <path d="M5 16h4M15 16h4" />
    </>
  ),
};

export interface EditorialIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: EditorialIconName;
  title?: string;
}

/** Cheers product-semantic icon. Utility actions should keep using platform-native icons. */
export function EditorialIcon({ name, title, ...props }: EditorialIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {iconArtwork[name]}
    </svg>
  );
}
