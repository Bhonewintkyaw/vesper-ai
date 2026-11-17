import React, { useMemo, useState } from 'react';
import {
  Check,
  LogIn,
  LogOut,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import type { ChatThread } from '../types/chat';

interface SidebarProps {
  isOpen: boolean;
  onCloseMobile: () => void;
  threads: ChatThread[];
  activeThreadId: string;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onRenameThread: (threadId: string, title: string) => void;
  onTogglePin: (threadId: string, pinned: boolean) => void;
  onDeleteThread: (threadId: string) => void;
  user: User | null;
  authReady: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  authError: string | null;
}

function formatRelativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Sidebar({
  isOpen,
  onCloseMobile,
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onRenameThread,
  onTogglePin,
  onDeleteThread,
  user,
  authReady,
  onSignIn,
  onSignOut,
  authError,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const filteredThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.lastMessagePreview.toLowerCase().includes(q)
    );
  }, [threads, searchQuery]);

  const pinnedThreads = useMemo(
    () => filteredThreads.filter((t) => t.pinned),
    [filteredThreads]
  );
  const recentThreads = useMemo(
    () => filteredThreads.filter((t) => !t.pinned),
    [filteredThreads]
  );

  const startRename = (thread: ChatThread) => {
    setEditingId(thread.id);
    setEditingTitle(thread.title);
    setConfirmDeleteId(null);
  };

  const commitRename = (threadId: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      onRenameThread(threadId, trimmed);
    }
    setEditingId(null);
  };

  const renderThreadRow = (thread: ChatThread) => {
    const isActive = thread.id === activeThreadId;
    const isEditing = editingId === thread.id;
    const isConfirmingDelete = confirmDeleteId === thread.id;

    return (
      <div
        key={thread.id}
        className={`group relative rounded-xl border transition-colors ${
          isActive
            ? 'border-violet-200 bg-white dark:border-[#8b5cf6]/40 dark:bg-[#181b26]/90'
            : 'border-transparent hover:bg-slate-100/80 dark:hover:bg-[#181b26]/50'
        }`}
      >
        {isEditing ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2">
            <input
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(thread.id);
                if (e.key === 'Escape') setEditingId(null);
              }}
              maxLength={140}
              autoFocus
              aria-label="Rename chat"
              className="min-w-0 flex-1 rounded-lg border border-violet-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none dark:border-[#8b5cf6] dark:bg-[#090a0f] dark:text-[#f8fafc]"
            />
            <button
              type="button"
              onClick={() => commitRename(thread.id)}
              aria-label="Save title"
              className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50 dark:text-[#4cd7f6] dark:hover:bg-[#1e2333]"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              aria-label="Cancel rename"
              className="rounded p-1.5 text-slate-500 hover:bg-slate-200 dark:text-[#94a3b8] dark:hover:bg-[#1e2333]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2 px-3 py-2.5">
            <button
              type="button"
              onClick={() => {
                onSelectThread(thread.id);
                onCloseMobile();
              }}
              className="min-w-0 flex-1 text-left focus-visible:outline-none"
            >
              <div className="truncate text-[13px] font-medium text-slate-900 dark:text-[#e3e1e9]">
                {thread.title}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400 tabular-nums dark:text-[#64748b]">
                {formatRelativeTime(thread.updatedAtMs)}
              </div>
            </button>

            <div
              className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
                isConfirmingDelete || isActive
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
              }`}
            >
              {isConfirmingDelete ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteThread(thread.id);
                      setConfirmDeleteId(null);
                    }}
                    className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700 whitespace-nowrap"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    aria-label="Cancel delete"
                    className="rounded p-1 text-slate-500 hover:bg-slate-200 dark:text-[#94a3b8] dark:hover:bg-[#1e2333]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onTogglePin(thread.id, !thread.pinned)}
                    aria-label={thread.pinned ? 'Unpin chat' : 'Pin chat'}
                    title={thread.pinned ? 'Unpin' : 'Pin'}
                    className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700 dark:text-[#64748b] dark:hover:bg-[#1e2333] dark:hover:text-[#f8fafc]"
                  >
                    {thread.pinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => startRename(thread)}
                    aria-label="Rename chat"
                    title="Rename"
                    className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700 dark:text-[#64748b] dark:hover:bg-[#1e2333] dark:hover:text-[#f8fafc]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(thread.id)}
                    aria-label="Delete chat"
                    title="Delete"
                    className="rounded p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-[#64748b] dark:hover:bg-red-950/50 dark:hover:text-[#ffb4ab]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-[#090a0f]/60 backdrop-blur-xs lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="Chat history"
        className={`fixed inset-y-0 left-0 z-40 flex w-[264px] shrink-0 flex-col border-r border-slate-200 bg-slate-50 transition-transform duration-200 ease-out dark:border-[#1e2333] dark:bg-[#0f111a] lg:static lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full lg:hidden'
        }`}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-slate-200 px-4 dark:border-[#1e2333]">
          <span className="font-display text-base font-bold tracking-tight text-slate-950 whitespace-nowrap shrink-0 dark:text-[#f8fafc]">
            Vesper
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                onNewThread();
                onCloseMobile();
              }}
              className="inline-flex items-center gap-1.5 rounded-full border-t border-white/25 bg-gradient-to-r from-[#8b5cf6] to-[#7c3aed] px-3 py-1.5 text-xs font-medium text-white shadow-[0_0_16px_rgba(139,92,246,0.35)] transition-transform hover:brightness-110 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] whitespace-nowrap shrink-0"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              <span>New Chat</span>
            </button>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close sidebar"
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200 lg:hidden dark:text-[#94a3b8] dark:hover:bg-[#181b26]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#64748b]" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats..."
              aria-label="Search chats"
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-violet-500 focus:outline-none dark:border-[#1e2333] dark:bg-[#181b26]/70 dark:text-[#e3e1e9] dark:placeholder:text-[#64748b] dark:focus:border-[#8b5cf6]"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {filteredThreads.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <p className="text-xs font-medium text-slate-600 dark:text-[#94a3b8]">
                {searchQuery ? 'No matching chats' : 'No saved chats yet'}
              </p>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-[#64748b]">
                {searchQuery
                  ? 'Try another keyword.'
                  : 'Say hi below to start chatting.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {pinnedThreads.length > 0 && (
                <div>
                  <div className="mb-1.5 px-2 font-mono text-[11px] font-medium tracking-[0.06em] text-slate-500 dark:text-[#958ea0]">
                    Pinned
                  </div>
                  <div className="space-y-1">{pinnedThreads.map(renderThreadRow)}</div>
                </div>
              )}

              {recentThreads.length > 0 && (
                <div>
                  <div className="mb-1.5 px-2 font-mono text-[11px] font-medium tracking-[0.06em] text-slate-500 dark:text-[#958ea0]">
                    Recent
                  </div>
                  <div className="space-y-1">{recentThreads.map(renderThreadRow)}</div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 p-3 dark:border-[#1e2333]">
          {authError && (
            <p className="mb-2 text-[11px] text-red-600 dark:text-[#ffb4ab]">{authError}</p>
          )}
          {!authReady ? (
            <div className="h-10 animate-pulse rounded-xl bg-slate-200/70 dark:bg-[#181b26]" />
          ) : user ? (
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                {user.photoURL && !avatarFailed ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'User avatar'}
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarFailed(true)}
                    className="h-8 w-8 shrink-0 rounded-lg border border-slate-200 object-cover dark:border-[#1e2333]"
                  />
                ) : (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-200 text-xs font-semibold text-slate-700 dark:border-[#1e2333] dark:bg-[#181b26] dark:text-[#d0bcff]">
                    {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-slate-900 dark:text-[#e3e1e9]">
                    {user.displayName || 'Signed In'}
                  </div>
                  <div className="truncate text-[11px] text-slate-500 dark:text-[#64748b]">
                    {user.email}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:text-[#94a3b8] dark:hover:bg-[#181b26] dark:hover:text-[#f8fafc]"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={onSignIn}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:border-[#1e2333] dark:bg-[#181b26]/70 dark:text-[#e3e1e9] dark:hover:bg-[#181b26] whitespace-nowrap"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>Sign in with Google</span>
              </button>
              <p className="text-center text-[11px] text-slate-500 dark:text-[#64748b]">
                Save your chats across devices
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
