/**
 * AttachmentCountBadge——清單列專用的極輕量相片數小徽章（v1.39 4A-1）。
 * 僅讀取 attachmentStore 的計數數字，絕不觸碰 photo_data。
 */
import "./attachments.css";

export function IconCamera({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.2 5.4a1.2 1.2 0 0 1 1.2-1.2h1.7l.9-1.4h4l.9 1.4h1.7a1.2 1.2 0 0 1 1.2 1.2v6.4a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V5.4Z" />
      <circle cx="8" cy="8.5" r="2.3" />
    </svg>
  );
}

export function AttachmentCountBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={`ns-att-badge${className ? ` ${className}` : ""}`}
      title={`附有 ${count} 張相片`}
      aria-label={`附有 ${count} 張相片`}
    >
      <IconCamera size={11} />
      <span>{count}</span>
    </span>
  );
}
