import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Download, ExternalLink } from 'lucide-react';

function GeneratedImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src) return null;

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="my-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100 dark:border-[#1e2333] dark:bg-[#0f111a] dark:text-[#cbd3e1]"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        <span>Open generated image{alt ? `: ${alt}` : ''}</span>
      </a>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-[#1e2333] dark:bg-[#0f111a]">
      <img
        src={src}
        alt={alt || 'Generated image'}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="max-h-[420px] w-full bg-slate-100 object-contain dark:bg-[#090a0f]"
      />
      <div className="flex items-center justify-between gap-2 border-t border-slate-200/80 px-3 py-2 text-xs dark:border-[#1e2333]">
        <span className="truncate text-[11px] text-slate-500 dark:text-[#94a3b8]">
          {alt || 'Generated image'}
        </span>
        <a
          href={src}
          download="vesper-generated-image.jpg"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-[#1e2333] dark:bg-[#181b26] dark:text-[#cbd3e1] dark:hover:bg-[#222636]"
        >
          <Download className="h-3 w-3" />
          <span>Download</span>
        </a>
      </div>
    </div>
  );
}

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-([\w-]+)/.exec(className || '');
  const language = match?.[1] || 'code';
  const codeText = String(children ?? '').replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-slate-200 bg-[#0b0d14] text-[#e3e1e9] dark:border-[#1e2333]">
      <div className="flex items-center justify-between border-b border-[#1e2333] bg-[#0f111a] px-3.5 py-2">
        <span className="font-mono text-[11px] font-medium tracking-[0.06em] text-[#4cd7f6]">
          {language}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] font-medium text-[#94a3b8] transition-colors hover:bg-[#181b26] hover:text-[#f8fafc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-[#4cd7f6]" />
              <span className="text-[#4cd7f6]">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 text-[13px] leading-[20px]">
        <code className={className}>{codeText}</code>
      </pre>
    </div>
  );
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          img({ src, alt }) {
            return <GeneratedImage src={src} alt={alt} />;
          },
          code({ className, children, ...props }) {
            const isBlock =
              Boolean(className?.includes('language-')) ||
              String(children).includes('\n');
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a({ href, children, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
