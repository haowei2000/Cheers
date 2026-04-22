interface DragOverlayProps {
  visible: boolean;
  isDark: boolean;
}

export function DragOverlay({ visible, isDark }: DragOverlayProps) {
  if (!visible) return null;
  return (
    <>
      <style>{`
        @keyframes charColorCycle {
          0%   { color: hsl(270,75%,60%); }
          14%  { color: hsl(330,80%,60%); }
          28%  { color: hsl(10, 85%,60%); }
          42%  { color: hsl(35, 92%,52%); }
          56%  { color: hsl(60, 88%,46%); }
          70%  { color: hsl(130,65%,48%); }
          84%  { color: hsl(200,72%,50%); }
          92%  { color: hsl(230,75%,60%); }
          100% { color: hsl(270,75%,60%); }
        }
        @keyframes dropIconBounce {
          0%,100% { transform: translateY(0px); }
          50%     { transform: translateY(12px); }
        }
        .drag-overlay-char {
          display: inline-block;
          animation: charColorCycle 3.5s linear infinite;
          font-weight: 900;
          letter-spacing: 0.04em;
        }
      `}</style>
      <div
        className="absolute inset-0 z-50 flex flex-col items-center justify-center select-none pointer-events-none"
        style={{
          backdropFilter: "blur(8px)",
          backgroundColor: isDark
            ? "rgba(26,29,33,0.75)"
            : "rgba(255,255,255,0.65)",
        }}
      >
        <div
          style={{ animation: "dropIconBounce 1.3s ease-in-out infinite" }}
          className="mb-7"
        >
          <svg
            width="72"
            height="72"
            viewBox="0 0 72 72"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect
              x="10"
              y="6"
              width="38"
              height="48"
              rx="5"
              fill="#EEF2FF"
              stroke="#818CF8"
              strokeWidth="2.5"
            />
            <path d="M48 6 L48 18 L60 18Z" fill="#818CF8" />
            <rect
              x="22"
              y="6"
              width="30"
              height="48"
              rx="5"
              fill="#E0F2FE"
              stroke="#38BDF8"
              strokeWidth="2.5"
              transform="rotate(-6 22 6)"
            />
            <rect
              x="18"
              y="10"
              width="30"
              height="48"
              rx="5"
              fill="#F0FDF4"
              stroke="#4ADE80"
              strokeWidth="2.5"
              transform="rotate(-12 18 10)"
            />
            <path
              d="M36 54 L36 40 M36 54 L29 47 M36 54 L43 47"
              stroke="#6366F1"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div
          className="text-5xl mb-5"
          style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}
        >
          {"可拖拽文件到此处".split("").map((char, i) => (
            <span
              key={i}
              className="drag-overlay-char"
              style={{ animationDelay: `${-(i / 8) * 3.5}s` }}
            >
              {char}
            </span>
          ))}
        </div>
        <p className="text-sm text-gray-400 text-center leading-relaxed">
          图片：PNG、JPG、JPEG、WEBP、GIF
          <br />
          文档：PDF、TXT、MD、DOCX、XLSX
        </p>
      </div>
    </>
  );
}
