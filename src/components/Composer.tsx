import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CornerDownLeft,
  FileText,
  Globe,
  History,
  Link2,
  Loader2,
  Mic,
  Paperclip,
  Radio,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AttachmentItem,
  ComposerMode,
  FreeModelPreset,
  VesperModule,
} from '../types/chat';

export interface ComposerSendOptions {
  mode: ComposerMode;
  modelPreset: FreeModelPreset;
}

interface ComposerProps {
  isStreaming: boolean;
  activeModules: VesperModule[];
  recentUserPrompts?: string[];
  prefillText?: string;
  onConsumePrefill?: () => void;
  onSend: (text: string, attachments: AttachmentItem[], options: ComposerSendOptions) => void;
  onStop: () => void;
  onOpenVoice: () => void;
}

const ACCEPTED_MIME_PREFIXES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ACCEPTED_DOC_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const PROMPT_HISTORY_KEY = 'vesper_prompt_history_v1';
const MAX_PROMPT_HISTORY = 100;

function loadPromptHistory(): string[] {
  try {
    const raw = localStorage.getItem(PROMPT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function savePromptHistory(items: string[]) {
  try {
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(items.slice(0, MAX_PROMPT_HISTORY)));
  } catch {
    // ignore storage errors
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to encode audio recording.'));
    reader.readAsDataURL(blob);
  });
}

export function Composer({
  isStreaming,
  activeModules,
  recentUserPrompts = [],
  prefillText,
  onConsumePrefill,
  onSend,
  onStop,
  onOpenVoice,
}: ComposerProps) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ComposerMode>('chat');
  const [modelPreset, setModelPreset] = useState<FreeModelPreset>('flash-lite');

  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const [promptHistory, setPromptHistory] = useState<string[]>(loadPromptHistory);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historySelectedIdx, setHistorySelectedIdx] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const historySearchInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<string>('');
  const clearedHistoryRef = useRef<boolean>(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const cancelRecordingRef = useRef<boolean>(false);

  const focusTextareaAtEnd = (nextLength?: number) => {
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = typeof nextLength === 'number' ? nextLength : el.value.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  useEffect(() => {
    if (clearedHistoryRef.current || recentUserPrompts.length === 0) return;
    setPromptHistory((prev) => {
      const existing = new Set(prev);
      const additions: string[] = [];
      for (let i = recentUserPrompts.length - 1; i >= 0; i -= 1) {
        const candidate = recentUserPrompts[i]?.trim();
        if (candidate && !existing.has(candidate)) {
          existing.add(candidate);
          additions.push(candidate);
        }
      }
      if (additions.length === 0) return prev;
      return [...prev, ...additions].slice(0, MAX_PROMPT_HISTORY);
    });
  }, [recentUserPrompts]);

  useEffect(() => {
    if (prefillText) {
      setInput(prefillText);
      setHistoryIndex(-1);
      draftRef.current = prefillText;
      onConsumePrefill?.();
      focusTextareaAtEnd(prefillText.length);
    }
  }, [prefillText, onConsumePrefill]);

  useEffect(() => {
    if (historyOpen) {
      setHistorySelectedIdx(0);
      setTimeout(() => historySearchInputRef.current?.focus(), 0);
    }
  }, [historyOpen]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
      if (recordStreamRef.current) {
        recordStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const slashSuggestions = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const firstToken = input.split(/\s/)[0].toLowerCase();
    if (input.includes(' ')) return [];
    return activeModules.filter(
      (m) =>
        m.enabled &&
        (m.command.toLowerCase().startsWith(firstToken) ||
          m.name.toLowerCase().includes(firstToken.slice(1)))
    );
  }, [input, activeModules]);

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return promptHistory;
    return promptHistory.filter((item) => item.toLowerCase().includes(q));
  }, [promptHistory, historyQuery]);

  const applySlashCommand = (command: string) => {
    setInput(`${command} `);
    setHistoryIndex(-1);
    textareaRef.current?.focus();
  };

  const restoreHistoryPrompt = (text: string) => {
    setInput(text);
    setHistoryIndex(-1);
    draftRef.current = text;
    setHistoryOpen(false);
    setHistoryQuery('');
    focusTextareaAtEnd(text.length);
  };

  const clearPromptHistory = () => {
    clearedHistoryRef.current = true;
    setPromptHistory([]);
    setHistoryIndex(-1);
    setHistoryQuery('');
    savePromptHistory([]);
    setHistoryOpen(false);
    focusTextareaAtEnd();
  };

  const handleFiles = async (files: FileList | File[]) => {
    setAttachError(null);
    const list = Array.from(files);
    if (attachments.length + list.length > MAX_ATTACHMENTS) {
      setAttachError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      return;
    }

    const nextItems: AttachmentItem[] = [];
    for (const file of list) {
      const mime = file.type || (file.name.endsWith('.md') ? 'text/markdown' : 'text/plain');
      const isImage = ACCEPTED_MIME_PREFIXES.includes(mime);
      const isDoc =
        ACCEPTED_DOC_TYPES.has(mime) ||
        file.name.endsWith('.ts') ||
        file.name.endsWith('.tsx');
      if (!isImage && !isDoc) {
        setAttachError(`Unsupported file type: ${file.name}. Use images, PDF, or text files.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setAttachError(`${file.name} exceeds the 3 MB limit.`);
        continue;
      }
      try {
        const data = await readFileAsBase64(file);
        const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
        nextItems.push({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          mimeType: isImage || ACCEPTED_DOC_TYPES.has(mime) ? mime : 'text/plain',
          size: file.size,
          data,
          previewUrl,
        });
      } catch {
        setAttachError(`Could not read ${file.name}.`);
      }
    }

    if (nextItems.length > 0) {
      setAttachments((prev) => [...prev, ...nextItems]);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl && target.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  };

  const stopRecordingStream = () => {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordStreamRef.current) {
      recordStreamRef.current.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
    }
    recorderRef.current = null;
  };

  const startRecording = async () => {
    if (isRecording || isTranscribing || isStreaming) return;
    setAttachError(null);
    cancelRecordingRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;

      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg',
      ];
      const supportedMime =
        preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);

      recordChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const mimeType = recorder.mimeType || supportedMime || 'audio/webm';
        const chunks = [...recordChunksRef.current];
        recordChunksRef.current = [];
        stopRecordingStream();
        setIsRecording(false);
        setRecordSeconds(0);

        if (cancelRecordingRef.current || chunks.length === 0) {
          return;
        }

        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < 256) {
          setAttachError('Recording was too short to transcribe.');
          return;
        }

        setIsTranscribing(true);
        try {
          const audioData = await blobToBase64(blob);
          const res = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioData, mimeType }),
          });
          const data = (await res.json()) as { transcript?: string; error?: string };
          if (!res.ok) {
            throw new Error(data.error || 'Could not transcribe audio.');
          }
          const clean = (data.transcript || '').replace(/—/g, '-').trim();
          if (clean) {
            setInput((prev) => (prev.trim() ? `${prev.trim()} ${clean}` : clean));
            setTimeout(() => textareaRef.current?.focus(), 0);
          } else {
            setAttachError('No speech detected in the recording.');
          }
        } catch (err) {
          setAttachError(
            err instanceof Error ? err.message : 'Audio transcription failed.'
          );
        } finally {
          setIsTranscribing(false);
        }
      };

      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch (err) {
      stopRecordingStream();
      setAttachError(
        err instanceof Error
          ? err.message
          : 'Microphone access is required for audio transcription.'
      );
    }
  };

  const stopAndTranscribe = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      cancelRecordingRef.current = false;
      recorderRef.current.stop();
    }
  };

  const cancelRecording = () => {
    cancelRecordingRef.current = true;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else {
      stopRecordingStream();
      setIsRecording(false);
      setRecordSeconds(0);
    }
  };

  const handleSubmit = () => {
    if (isStreaming || isRecording || isTranscribing) return;
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;

    if (trimmed) {
      clearedHistoryRef.current = false;
      setPromptHistory((prev) => {
        const deduped = [trimmed, ...prev.filter((item) => item !== trimmed)].slice(
          0,
          MAX_PROMPT_HISTORY
        );
        savePromptHistory(deduped);
        return deduped;
      });
    }

    onSend(trimmed, attachments, {
      mode,
      modelPreset,
    });
    setInput('');
    setHistoryIndex(-1);
    setHistoryOpen(false);
    setHistoryQuery('');
    draftRef.current = '';
    setAttachments([]);
    setAttachError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      e.preventDefault();
      void handleFiles(items);
    }
  };

  const placeholderText =
    mode === 'search'
      ? 'Search live web info with Google Search...'
      : mode === 'url'
      ? 'Paste a web link (https://...) and ask Vesper to read or summarize it...'
      : 'Message Vesper...';

  return (
    <div className="px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:px-6">
      <div className="relative mx-auto max-w-2xl">
        {historyOpen && (
          <div className="absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg dark:border-[#1e2333] dark:border-t-white/10 dark:bg-[#181b26]/95 dark:shadow-[0_0_32px_-8px_rgba(139,92,246,0.28)] dark:backdrop-blur-2xl">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-[#1e2333]">
              <Search className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-[#4cd7f6]" />
              <input
                ref={historySearchInputRef}
                type="text"
                value={historyQuery}
                onChange={(e) => {
                  setHistoryQuery(e.target.value);
                  setHistorySelectedIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setHistoryOpen(false);
                    setHistoryQuery('');
                    focusTextareaAtEnd();
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHistorySelectedIdx((idx) =>
                      filteredHistory.length === 0 ? 0 : Math.min(idx + 1, filteredHistory.length - 1)
                    );
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHistorySelectedIdx((idx) => Math.max(0, idx - 1));
                    return;
                  }
                  if (e.key === 'Enter' && filteredHistory[historySelectedIdx]) {
                    e.preventDefault();
                    restoreHistoryPrompt(filteredHistory[historySelectedIdx]);
                  }
                }}
                placeholder="reverse-i-search: filter previous prompts..."
                aria-label="Search prompt history"
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-[#f8fafc] dark:placeholder:text-[#64748b]"
              />
              {promptHistory.length > 0 && (
                <button
                  type="button"
                  onClick={clearPromptHistory}
                  title="Clear saved prompt history"
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 dark:text-[#94a3b8] dark:hover:bg-[#0f111a] dark:hover:text-[#ffb4ab] whitespace-nowrap shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Clear</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setHistoryOpen(false);
                  setHistoryQuery('');
                  focusTextareaAtEnd();
                }}
                aria-label="Close prompt history"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-[#94a3b8] dark:hover:bg-[#0f111a] dark:hover:text-[#f8fafc]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="max-h-56 overflow-y-auto p-1.5">
              {filteredHistory.length === 0 ? (
                <div className="px-3 py-4 text-center font-mono text-xs text-slate-400 dark:text-[#64748b]">
                  {promptHistory.length === 0
                    ? 'No prompt history yet. Send a message, then use Up arrow or Ctrl+R.'
                    : 'No matching prompts found.'}
                </div>
              ) : (
                filteredHistory.map((item, idx) => {
                  const selected = idx === historySelectedIdx;
                  return (
                    <button
                      key={`${idx}-${item.slice(0, 24)}`}
                      type="button"
                      onMouseEnter={() => setHistorySelectedIdx(idx)}
                      onClick={() => restoreHistoryPrompt(item)}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                        selected
                          ? 'bg-slate-100 dark:bg-[#292a2f]/80'
                          : 'hover:bg-slate-100/70 dark:hover:bg-[#292a2f]/50'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="w-5 shrink-0 text-right font-mono text-[10px] text-slate-400 tabular-nums dark:text-[#64748b]">
                          {idx + 1}
                        </span>
                        <span className="truncate font-mono text-xs text-slate-800 dark:text-[#e3e1e9]">
                          {item.replace(/\s+/g, ' ')}
                        </span>
                      </div>
                      {selected && (
                        <CornerDownLeft className="h-3 w-3 shrink-0 text-violet-600 dark:text-[#4cd7f6]" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        {slashSuggestions.length > 0 && !historyOpen && (
          <div className="absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg dark:border-[#1e2333] dark:border-t-white/10 dark:bg-[#181b26]/92 dark:shadow-[0_0_32px_-8px_rgba(139,92,246,0.25)] dark:backdrop-blur-2xl">
            <div className="border-b border-slate-100 px-3.5 py-2 font-mono text-[11px] font-medium tracking-[0.06em] text-slate-500 dark:border-[#1e2333] dark:text-[#958ea0]">
              Modules
            </div>
            <div className="max-h-52 overflow-y-auto p-1.5">
              {slashSuggestions.map((mod) => (
                <button
                  key={mod.id}
                  type="button"
                  onClick={() => applySlashCommand(mod.command)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-slate-100 dark:hover:bg-[#292a2f]/70"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium text-violet-600 dark:text-[#4cd7f6]">
                        {mod.command}
                      </span>
                      <span className="text-xs font-medium text-slate-900 dark:text-[#f8fafc]">
                        {mod.name}
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-slate-500 dark:text-[#94a3b8]">
                      {mod.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {attachError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-[#93000a] dark:bg-[#93000a]/30 dark:text-[#ffb4ab]">
            <span>{attachError}</span>
            <button
              type="button"
              onClick={() => setAttachError(null)}
              aria-label="Dismiss error"
              className="rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files?.length) {
              void handleFiles(e.dataTransfer.files);
            }
          }}
          className={`rounded-2xl border bg-slate-50 transition-all dark:bg-[#0f111a]/85 dark:backdrop-blur-xl ${
            isDragging
              ? 'border-[#06b6d4] ring-2 ring-[#06b6d4]/25'
              : 'border-slate-200 focus-within:border-violet-400 focus-within:bg-white dark:border-[#1e2333] dark:border-t-white/10 dark:focus-within:border-[#8b5cf6]/65 dark:focus-within:shadow-[0_0_24px_-6px_rgba(139,92,246,0.3)]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/70 px-3 py-2 dark:border-[#1e2333]/80">
            <div className="flex items-center gap-1" role="group" aria-label="Composer mode">
              <button
                type="button"
                onClick={() => setMode('chat')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'chat'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-[#181b26] dark:text-[#f8fafc] dark:ring-1 dark:ring-[#8b5cf6]/45'
                    : 'text-slate-500 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:text-[#f8fafc]'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Chat</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('search')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'search'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-[#181b26] dark:text-[#4cd7f6] dark:ring-1 dark:ring-[#06b6d4]/50'
                    : 'text-slate-500 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:text-[#f8fafc]'
                }`}
              >
                <Globe className="h-3.5 w-3.5" />
                <span>Search</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('url')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'url'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-[#181b26] dark:text-[#d0bcff] dark:ring-1 dark:ring-[#8b5cf6]/50'
                    : 'text-slate-500 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:text-[#f8fafc]'
                }`}
              >
                <Link2 className="h-3.5 w-3.5" />
                <span>URL Reader</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {historyIndex >= 0 && promptHistory.length > 0 && (
                <span className="hidden font-mono text-[11px] text-slate-400 tabular-nums sm:inline dark:text-[#4cd7f6]">
                  history {historyIndex + 1}/{promptHistory.length}
                </span>
              )}
              <button
                type="button"
                onClick={() => setHistoryOpen((prev) => !prev)}
                title="Restore previous prompt (Up arrow or Ctrl+R)"
                aria-label="Restore previous prompt"
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  historyOpen
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-[#181b26] dark:text-[#4cd7f6] dark:ring-1 dark:ring-[#06b6d4]/50'
                    : 'text-slate-500 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:text-[#f8fafc]'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">History</span>
              </button>
              <label htmlFor="free-model-select" className="sr-only">
                AI Model
              </label>
              <select
                id="free-model-select"
                value={mode === 'chat' ? modelPreset : 'hydrogen-fast'}
                disabled={mode !== 'chat'}
                onChange={(e) => setModelPreset(e.target.value as FreeModelPreset)}
                aria-label="Select free AI model"
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-mono text-[11px] text-slate-700 focus:border-[#8b5cf6] focus:outline-none disabled:opacity-65 dark:border-[#1e2333] dark:bg-[#181b26] dark:text-[#cbd3e1]"
              >
                <option value="flash-lite">Flash Lite (Instant)</option>
                <option value="hydrogen-fast">Hydrogen 4 (Smart)</option>
                <option value="hydrogen-deep">Hydrogen 4 (Deep Think)</option>
              </select>
            </div>
          </div>

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-slate-200/80 px-3.5 pt-3 pb-2.5 dark:border-[#1e2333]">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-[#1e2333] dark:bg-[#181b26]"
                >
                  {att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      referrerPolicy="no-referrer"
                      className="h-7 w-7 rounded object-cover"
                    />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-slate-400 dark:text-[#4cd7f6]" />
                  )}
                  <div className="min-w-0 max-w-[140px]">
                    <div className="truncate font-medium text-slate-800 dark:text-[#e3e1e9]">
                      {att.name}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400 tabular-nums dark:text-[#64748b]">
                      {formatBytes(att.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    aria-label={`Remove ${att.name}`}
                    className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:text-[#94a3b8] dark:hover:bg-[#292a2f] dark:hover:text-[#f8fafc]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {isRecording ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
                <span className="text-xs font-medium text-slate-900 dark:text-[#f8fafc]">
                  Recording audio
                </span>
                <span className="font-mono text-xs text-slate-500 tabular-nums dark:text-[#4cd7f6]">
                  {formatDuration(recordSeconds)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={cancelRecording}
                  className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:text-[#94a3b8] dark:hover:bg-[#181b26]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={stopAndTranscribe}
                  className="inline-flex items-center gap-1.5 rounded-full border-t border-white/25 bg-gradient-to-r from-[#8b5cf6] to-[#7c3aed] px-3.5 py-1.5 text-xs font-medium text-white shadow-[0_0_16px_rgba(139,92,246,0.35)] whitespace-nowrap"
                >
                  <Square className="h-3 w-3 fill-current" />
                  <span>Transcribe</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-end gap-1.5 px-3 py-2.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    void handleFiles(e.target.files);
                    e.target.value = '';
                  }
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach code, logs, PDF, or image"
                aria-label="Attach code, logs, PDF, or image"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:text-[#94a3b8] dark:hover:bg-[#181b26] dark:hover:text-[#f8fafc]"
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  const val = e.target.value;
                  setInput(val);
                  if (historyIndex !== -1) {
                    setHistoryIndex(-1);
                  }
                  draftRef.current = val;
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'r') {
                    e.preventDefault();
                    setHistoryOpen((prev) => !prev);
                    return;
                  }

                  if (e.key === 'Escape' && historyIndex >= 0) {
                    e.preventDefault();
                    const restoredDraft = draftRef.current;
                    setInput(restoredDraft);
                    setHistoryIndex(-1);
                    focusTextareaAtEnd(restoredDraft.length);
                    return;
                  }

                  if (e.key === 'Tab' && slashSuggestions.length > 0) {
                    e.preventDefault();
                    applySlashCommand(slashSuggestions[0].command);
                    return;
                  }

                  const isCtrlP =
                    e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p';
                  const isCtrlN =
                    e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'n';

                  if ((e.key === 'ArrowUp' || isCtrlP) && !historyOpen && slashSuggestions.length === 0) {
                    const selStart = e.currentTarget.selectionStart ?? 0;
                    const onFirstLine = !input.slice(0, selStart).includes('\n');
                    if ((isCtrlP || onFirstLine) && promptHistory.length > 0) {
                      e.preventDefault();
                      if (historyIndex === -1) {
                        draftRef.current = input;
                      }
                      const nextIdx = Math.min(historyIndex + 1, promptHistory.length - 1);
                      const recalled = promptHistory[nextIdx];
                      setHistoryIndex(nextIdx);
                      setInput(recalled);
                      focusTextareaAtEnd(recalled.length);
                      return;
                    }
                  }

                  if ((e.key === 'ArrowDown' || isCtrlN) && !historyOpen && historyIndex >= 0) {
                    const selEnd = e.currentTarget.selectionEnd ?? input.length;
                    const onLastLine = !input.slice(selEnd).includes('\n');
                    if (isCtrlN || onLastLine) {
                      e.preventDefault();
                      if (historyIndex === 0) {
                        const restoredDraft = draftRef.current;
                        setHistoryIndex(-1);
                        setInput(restoredDraft);
                        focusTextareaAtEnd(restoredDraft.length);
                      } else {
                        const nextIdx = historyIndex - 1;
                        const recalled = promptHistory[nextIdx];
                        setHistoryIndex(nextIdx);
                        setInput(recalled);
                        focusTextareaAtEnd(recalled.length);
                      }
                      return;
                    }
                  }

                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder={isTranscribing ? 'Transcribing audio...' : placeholderText}
                aria-label="Chat message"
                className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-[#e3e1e9] dark:placeholder:text-[#64748b]"
              />

              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={isStreaming || isTranscribing}
                title="Transcribe audio from microphone"
                aria-label="Transcribe audio from microphone"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:text-[#94a3b8] dark:hover:bg-[#181b26] dark:hover:text-[#4cd7f6]"
              >
                {isTranscribing ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#4cd7f6]" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </button>

              <button
                type="button"
                onClick={onOpenVoice}
                disabled={isStreaming}
                title="Start live voice conversation"
                aria-label="Start live voice conversation"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06b6d4] dark:text-[#94a3b8] dark:hover:bg-[#181b26] dark:hover:text-[#4cd7f6]"
              >
                <Radio className="h-4 w-4" />
              </button>

              {isStreaming ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop generating"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#1e2333] bg-[#181b26] text-[#4cd7f6] shadow-[0_0_16px_rgba(6,182,212,0.25)] transition-transform hover:brightness-110 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06b6d4]"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={(!input.trim() && attachments.length === 0) || isTranscribing}
                  aria-label="Send message"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-t border-white/25 bg-gradient-to-r from-[#8b5cf6] to-[#7c3aed] text-white shadow-[0_0_16px_rgba(139,92,246,0.35)] transition-all hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
