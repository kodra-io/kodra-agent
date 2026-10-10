import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The agent's answers as formatted text. Model output is untrusted: no raw HTML (the
 * default), no images (they would load from other sites; the alt text shows instead), and
 * links open in a new tab without a referrer. react-markdown drops unsafe link protocols.
 */
const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-[15px] font-semibold first:mt-0">{children}</h4>
  ),
  h4: ({ children }) => <h4 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 ps-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 ps-6">{children}</ol>,
  li: ({ children }) => <li className="ps-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-text underline underline-offset-2"
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="text-ink-secondary">[{alt || 'image'}]</span>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-s-2 border-line-strong ps-3 text-ink-secondary">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className={`${className} font-mono`}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.86em]">{children}</code>
    ),
  pre: ({ children }) => (
    <pre
      dir="ltr"
      className="my-3 overflow-x-auto rounded-lg border border-line bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[19px]"
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line bg-surface px-3 py-2 text-start font-medium text-ink-secondary">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-t border-line px-3 py-2 align-top">{children}</td>,
  hr: () => <hr className="my-4 border-line" />,
};

export function MarkdownText({ text }: { text: string }) {
  return (
    <div dir="auto" className="text-[15px] leading-6 break-words">
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}
