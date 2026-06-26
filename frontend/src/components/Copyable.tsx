import { useState, useCallback } from "react";
import type { ReactNode } from "react";

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export function Copyable({ text, className, block, children }: { text: string; className?: string; block?: boolean; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [text]);
  return (
    <span
      className={`cursor-pointer ${block ? "block truncate" : ""}  ${copied ? "text-green-400" : `hover:text-white ${className ?? ""}`}`}
      title={text}
      onClick={handleClick}
    >
      {children ?? text}
    </span>
  );
}
