import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react';
import type { ChatMessage, ChatModelId } from '../types/chat';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  userName?: string | null;
  onSelectStarterPrompt: (prompt: string) => void;
  onRegenerateLast: () => void;
  onRestorePrompt?: (text: string) => void;
}

const VESPER_STARTERS = [
  {
    title: 'Brainstorm an idea',
    subtitle: 'Plan a project, trip, gift, or creative concept together.',
    prompt: 'Hey Vesper! Help me brainstorm a practical weekend project or creative idea I can try.',
  },
  {
    title: 'Write or polish text',
    subtitle: 'Draft an email, rewrite a paragraph, or summarize notes.',
    prompt: 'Can you help me write a clear, friendly message and give me a couple of tone options?',
  },
  {
    title: 'Explain a topic',
    subtitle: 'Break down any subject clearly with simple examples.',
    prompt: 'Explain a complex topic in plain, everyday terms with real-world examples.',
  },
  {
    title: 'Help with code or docs',
    subtitle: 'Debug code, check errors, or analyze an uploaded file or image.',
    prompt: 'Can you review a code snippet or help me understand an error step by step?',
  },
];

function formatDomain(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return uri;
  }
}

function formatModelLabel(model?: ChatModelId): string | null {
  switch (model) {
    case 'gemini-3.1-flash-lite':
      return 'Flash Lite';
    case 'gemini-4-hydrogen':
      return 'Hydrogen 4';
    case 'gemini-3.8-live':
      return 'Live Voice';
    case 'flux-free':
      return 'Flux Free Image';
    default:
      return null;
  }
}

export function ChatMessageList({
  messages,
  isStreaming,
  userName,
  onSelectStarterPrompt,
  onRegenerateLast,
  onRestorePrompt,
}: ChatMessageListProps) {
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [ttsLoadingId, setTtsLoadingId] = useState<string | null>(null);
  const [ttsPlayingId, setTtsPlayingId] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const ttsCacheRef = useRef<Record<string, string>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isStreaming]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId(null), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setTtsPlayingId(null);
  };

  const handleListen = async (id: string, text: string) => {
    setTtsError(null);
    if (ttsPlayingId === id) {
      stopAudio();
      return;
    }

    stopAudio();

    try {
      let audioDataUrl = ttsCacheRef.current[id];
      if (!audioDataUrl) {
        setTtsLoadingId(id);
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: 'Zephyr' }),
        });
        const data = (await res.json()) as { audioDataUrl?: string; error?: string };
        if (!res.ok || !data.audioDataUrl) {
          throw new Error(data.error || 'Could not generate speech audio.');
        }
        audioDataUrl = data.audioDataUrl;
        ttsCacheRef.current[id] = audioDataUrl;
      }

      const audio = new Audio(audioDataUrl);
      audioRef.current = audio;
      setTtsPlayingId(id);
      audio.onended = () => {
        setTtsPlayingId((curr) => (curr === id ? null : curr));
        if (audioRef.current === audio) audioRef.current = null;
      };
      audio.onerror = () => {
        setTtsPlayingId(null);
        setTtsError('Audio playback failed.');
      };
      await audio.play();
    } catch (err) {
      setTtsPlayingId(null);
      setTtsError(err instanceof Error ? err.message : 'Speech playback failed.');
    } finally {
      setTtsLoadingId(null);
    }
  };

  if (messages.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:py-10">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center">
          <h1
            className="font-display text-3xl font-bold tracking-[-0.03em] text-slate-950 sm:text-4xl dark:text-[#f8fafc]"
            style={{ textWrap: 'balance' }}
          >
            {userName ? `Hey ${userName}, how can I help?` : 'Hey there, how can I help?'}
          </h1>
          <p className="mt-2.5 max-w-lg text-[15px] leading-relaxed text-slate-600 dark:text-[#94a3b8]">
            Ask a question, share a snippet, or just chat. I&apos;m ready whenever you are.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:mt-8 sm:grid-cols-2">
            {VESPER_STARTERS.map((item) => (
              <button
                key={item.title}
                type="button"
                onClick={() => onSelectStarterPrompt(item.prompt)}
                className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 text-left transition-all hover:border-violet-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:border-[#1e2333] dark:border-t-white/10 dark:bg-[#181b26]/80 dark:backdrop-blur-md dark:hover:border-[#8b5cf6]/50 dark:hover:bg-[#1e1f25]"
              >
                <span className="font-display text-sm font-semibold text-slate-900 dark:text-[#f8fafc]">
                  {item.title}
                </span>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-[#94a3b8]">
                  {item.subtitle}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const lastAssistantIdx = [...messages]
    .reverse()
    .findIndex((m) => m.role === 'model');
  const lastAssistantId =
    lastAssistantIdx >= 0 ? messages[messages.length - 1 - lastAssistantIdx]?.id : null;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-2xl space-y-6">
        {ttsError && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-[#93000a] dark:bg-[#93000a]/25 dark:text-[#ffb4ab]">
            <span>{ttsError}</span>
            <button
              type="button"
              onClick={() => setTtsError(null)}
              className="font-medium underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="group flex flex-col items-end gap-1">
                <div className="max-w-[82%] rounded-2xl rounded-br-sm border border-violet-200 bg-violet-600 px-4 py-2.5 text-[15px] leading-relaxed text-white dark:border-[#8b5cf6]/30 dark:bg-[#181b26] dark:text-[#e3e1e9]">
                  {msg.localAttachments && msg.localAttachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {msg.localAttachments.map((att) =>
                        att.previewUrl ? (
                          <img
                            key={att.id}
                            src={att.previewUrl}
                            alt={att.name}
                            referrerPolicy="no-referrer"
                            className="h-24 w-24 rounded-lg border border-white/20 object-cover dark:border-[#1e2333]"
                          />
                        ) : (
                          <div
                            key={att.id}
                            className="flex items-center gap-1.5 rounded-lg bg-violet-700/70 px-2.5 py-1.5 text-xs text-white dark:bg-[#0f111a] dark:text-[#cbd3e1]"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0" />
                            <span className="max-w-[160px] truncate">{att.name}</span>
                          </div>
                        )
                      )}
                    </div>
                  )}

                  {!msg.localAttachments?.length &&
                    msg.attachmentNames &&
                    msg.attachmentNames.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-violet-100 dark:text-[#94a3b8]">
                        {msg.attachmentNames.map((name, idx) => (
                          <React.Fragment key={`${name}-${idx}`}>
                            {idx > 0 && <span aria-hidden="true">·</span>}
                            <span className="inline-flex items-center gap-1">
                              <FileText className="h-3 w-3" />
                              <span>{name}</span>
                            </span>
                          </React.Fragment>
                        ))}
                      </div>
                    )}

                  <div className="whitespace-pre-wrap break-words">{msg.text}</div>
                </div>

                {onRestorePrompt && msg.text && (
                  <button
                    type="button"
                    onClick={() => onRestorePrompt(msg.text)}
                    title="Restore to input"
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-medium text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:text-[#64748b] dark:hover:bg-[#181b26] dark:hover:text-[#4cd7f6]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Restore</span>
                  </button>
                )}
              </div>
            );
          }

          const isLastAssistant = msg.id === lastAssistantId;
          const modelLabel = formatModelLabel(msg.model);
          const isTtsLoading = ttsLoadingId === msg.id;
          const isTtsPlaying = ttsPlayingId === msg.id;

          return (
            <div key={msg.id} className="group flex items-start gap-3">
              <div
                aria-hidden="true"
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border font-display text-xs font-semibold transition-colors ${
                  msg.isStreaming
                    ? 'border-[#06b6d4]/60 bg-[#0f111a] text-[#4cd7f6] shadow-[0_0_12px_rgba(6,182,212,0.25)]'
                    : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-[#1e2333] dark:bg-[#0f111a] dark:text-[#d0bcff]'
                }`}
              >
                V
              </div>

              <div className="min-w-0 flex-1 space-y-2.5">
                {msg.error ? (
                  <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/70 px-4 py-3 text-sm text-red-800 dark:border-[#93000a] dark:bg-[#93000a]/25 dark:text-[#ffb4ab]">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-[#ffb4ab]" />
                    <div className="min-w-0 flex-1">{msg.error}</div>
                  </div>
                ) : msg.isStreaming && !msg.text ? (
                  <div className="flex items-center gap-2.5 py-1.5 text-sm text-slate-500 dark:text-[#94a3b8]">
                    <span className="inline-block h-4 w-0.5 animate-pulse rounded-full bg-gradient-to-b from-[#06b6d4] to-[#8b5cf6]" />
                    <span className="font-mono text-xs tracking-wide text-slate-500 dark:text-[#4cd7f6]">
                      Replying...
                    </span>
                  </div>
                ) : (
                  <div
                    className={`relative transition-colors ${
                      msg.isStreaming
                        ? 'pl-3.5 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-gradient-to-b before:from-[#06b6d4] before:to-[#8b5cf6]'
                        : ''
                    }`}
                  >
                    <MarkdownRenderer content={msg.text} />
                    {msg.isStreaming && (
                      <span
                        aria-hidden="true"
                        className="ml-1 inline-block h-4 w-1.5 animate-pulse align-middle rounded-xs bg-[#06b6d4]"
                      />
                    )}
                  </div>
                )}

                {msg.sources && msg.sources.length > 0 && (
                  <div className="pt-1">
                    <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-[0.06em] text-slate-500 dark:text-[#958ea0]">
                      <Globe className="h-3 w-3 text-[#4cd7f6]" />
                      <span>Sources</span>
                    </div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {msg.sources.map((src, idx) => (
                        <a
                          key={`${src.uri}-${idx}`}
                          href={src.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs transition-colors hover:border-violet-300 hover:bg-white dark:border-[#1e2333] dark:bg-[#0f111a] dark:hover:border-[#06b6d4]/50 dark:hover:bg-[#181b26]"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-slate-800 dark:text-[#e3e1e9]">
                              {src.title}
                            </div>
                            <div className="truncate font-mono text-[10px] text-slate-400 dark:text-[#4cd7f6]">
                              {formatDomain(src.uri)}
                            </div>
                          </div>
                          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-[#64748b]" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {!msg.isStreaming && (msg.text || msg.error) && (
                  <div
                    className={`flex flex-wrap items-center gap-2 transition-opacity ${
                      isTtsPlaying || isTtsLoading
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                    }`}
                  >
                    {msg.text && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleCopy(msg.id, msg.text)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:text-[#64748b] dark:hover:bg-[#181b26] dark:hover:text-[#f8fafc]"
                        >
                          {copiedMessageId === msg.id ? (
                            <>
                              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-[#4cd7f6]" />
                              <span className="dark:text-[#4cd7f6]">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleListen(msg.id, msg.text)}
                          disabled={isTtsLoading}
                          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06b6d4] ${
                            isTtsPlaying
                              ? 'text-[#4cd7f6] hover:bg-[#181b26]'
                              : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-[#64748b] dark:hover:bg-[#181b26] dark:hover:text-[#f8fafc]'
                          }`}
                        >
                          {isTtsLoading ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4cd7f6]" />
                              <span>Loading audio</span>
                            </>
                          ) : isTtsPlaying ? (
                            <>
                              <Square className="h-3 w-3 fill-current" />
                              <span>Stop</span>
                            </>
                          ) : (
                            <>
                              <Volume2 className="h-3.5 w-3.5" />
                              <span>Listen</span>
                            </>
                          )}
                        </button>
                      </>
                    )}

                    {isLastAssistant && !isStreaming && (
                      <button
                        type="button"
                        onClick={onRegenerateLast}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:text-[#64748b] dark:hover:bg-[#181b26] dark:hover:text-[#f8fafc]"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Try again</span>
                      </button>
                    )}

                    {modelLabel && (
                      <span className="font-mono text-[11px] text-slate-400 dark:text-[#475569]">
                        {modelLabel}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={scrollEndRef} />
      </div>
    </div>
  );
}
