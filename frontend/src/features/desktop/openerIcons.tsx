// Brand-ish "app tile" glyphs for the remote-workspace "Open in …" buttons, so
// each installed opener shows a recognizable macOS-style icon instead of a
// generic stroke. These are hand-drawn, self-contained SVGs (no network, no
// asset files) in each app's accent colours — stylized marks, not the exact
// trademarked logos. Keys match connector.rs KNOWN_EDITORS + "finder".

const TILE = { x: 1.5, y: 1.5, width: 21, height: 21, rx: 5.5 } as const;

function Finder() {
  return (
    <>
      <rect {...TILE} fill="#31A9FF" />
      <rect x="8" y="8" width="1.7" height="3.4" rx="0.85" fill="#fff" />
      <rect x="14.3" y="8" width="1.7" height="3.4" rx="0.85" fill="#fff" />
      <path
        d="M8 14.4 Q12 17.6 16 14.4"
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  );
}

function VSCode() {
  // The folded-ribbon mark (simple-icons path) in white on the VS Code blue tile.
  return (
    <>
      <rect {...TILE} fill="#0E6CB8" />
      <path
        transform="translate(3.5 3.5) scale(.708)"
        fill="#fff"
        d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448z"
      />
    </>
  );
}

function Cursor() {
  return (
    <>
      <rect {...TILE} fill="#141414" />
      <path d="M12 5 L17.4 18.4 L12 15.7 L6.6 18.4 Z" fill="#f4f4f5" />
    </>
  );
}

function Zed() {
  return (
    <>
      <rect {...TILE} fill="#18181B" />
      <path
        d="M7.6 7.6 H16.4 L7.6 16.4 H16.4"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </>
  );
}

/** JetBrains IDEs share a two-tone angular tile; colour distinguishes them. */
function JetBrains({ a, b }: { a: string; b: string }) {
  return (
    <>
      <rect {...TILE} fill={a} />
      <path d="M22.5 7 V22.5 H7 Z" fill={b} />
      <rect x="6" y="17.4" width="8.2" height="1.7" rx="0.85" fill="#fff" />
    </>
  );
}

function Sublime() {
  return (
    <>
      <rect {...TILE} fill="#FF9800" />
      <path
        d="M15 8 H10.3 A2.1 2.1 0 0 0 10.3 12.1 H13.4 A2.1 2.1 0 0 1 13.4 16 H9"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </>
  );
}

function Generic() {
  return (
    <>
      <rect {...TILE} fill="#3F3F46" />
      <path
        d="M9.5 14.5 L15 9 M15 9 H10.5 M15 9 V13.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

function glyphFor(k: string) {
  switch (k) {
    case "finder":
      return <Finder />;
    case "vscode":
      return <VSCode />;
    case "cursor":
      return <Cursor />;
    case "zed":
      return <Zed />;
    case "pycharm":
      return <JetBrains a="#21D789" b="#FCF84A" />;
    case "webstorm":
      return <JetBrains a="#07C3F2" b="#0A65FF" />;
    case "rustrover":
      return <JetBrains a="#12B886" b="#FE6F42" />;
    case "sublime":
      return <Sublime />;
    default:
      return <Generic />;
  }
}

/** Embedded app-tile icon for an opener key. */
export function OpenerGlyph({
  k,
  className = "w-[18px] h-[18px]",
}: {
  k: string;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {glyphFor(k)}
    </svg>
  );
}
