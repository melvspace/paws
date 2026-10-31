import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatImage } from "./ChatImage.tsx";

// T3 Code also uses react-markdown with remark-gfm. Keep raw HTML disabled.
export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, node }) =>
            node?.children.some(
              (child) => child.type === "element" && child.tagName === "img",
            ) ? (
              <span>{children}</span>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          img: ({ src, alt, title }) =>
            src ? <ChatImage src={src} alt={alt ?? ""} title={title} /> : null,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
