import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  Menu,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  Radio,
  Sun,
} from 'lucide-react';
import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import {
  auth,
  signInWithGoogle,
  signOutUser,
  testFirestoreConnection,
} from './lib/firebase';
import {
  createMessageRecord,
  createModuleRecord,
  createThreadRecord,
  deleteMessageRecord,
  deleteModuleRecord,
  deleteThreadAndMessages,
  ensureUserProfile,
  generateSafeId,
  LIMITS,
  subscribeThreadMessages,
  subscribeUserModules,
  subscribeUserThreads,
  updateModuleRecord,
  updateThreadPinned,
  updateThreadSummary,
  updateThreadTitle,
} from './lib/firestoreChat';
import { BUILT_IN_MODULES } from './lib/modules';
import type {
  AdaptiveMode,
  AttachmentItem,
  ChatMessage,
  ChatModelId,
  ChatThread,
  GroundingSource,
  ThinkingDepth,
  UserPreferences,
  VesperModule,
} from './types/chat';
import { Sidebar } from './components/Sidebar';
import { ChatMessageList } from './components/ChatMessageList';
import { Composer } from './components/Composer';
import type { ComposerSendOptions } from './components/Composer';
import { ModulesModal } from './components/ModulesModal';
import { VoiceSessionModal } from './components/VoiceSessionModal';

const GUEST_THREADS_KEY = 'vesper_guest_threads_v1';
const GUEST_MESSAGES_KEY = 'vesper_guest_messages_v1';
const GUEST_MODULES_KEY = 'vesper_guest_modules_v1';
const BUILTIN_TOGGLES_KEY = 'vesper_builtin_toggles_v1';
const ADAPTIVE_MODE_KEY = 'vesper_adaptive_mode_v1';
const THEME_KEY = 'vesper_theme_v2';

const DEFAULT_PREFS: UserPreferences = {
  defaultModel: 'gemini-3.1-flash-lite',
  defaultThinkingLevel: 'MINIMAL',
  defaultSystemInstruction: '',
};

function createEmptyThread(prefs: UserPreferences): ChatThread {
  const now = Date.now();
  return {
    id: generateSafeId('thr'),
    title: 'New Chat',
    model: prefs.defaultModel,
    thinkingLevel: prefs.defaultThinkingLevel,
    systemInstruction: prefs.defaultSystemInstruction,
    useSearch: false,
    pinned: false,
    messageCount: 0,
    lastMessagePreview: '',
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function loadGuestThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(GUEST_THREADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatThread[]) : [];
  } catch {
    return [];
  }
}

function loadGuestMessages(): Record<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(GUEST_MESSAGES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, ChatMessage[]>)
      : {};
  } catch {
    return {};
  }
}

function loadGuestModules(): VesperModule[] {
  try {
    const raw = localStorage.getItem(GUEST_MODULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VesperModule[]) : [];
  } catch {
    return [];
  }
}

function loadBuiltInToggles(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(BUILTIN_TOGGLES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function resolveFreeModelConfig(options: ComposerSendOptions): {
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  thinkingLevel: ThinkingDepth;
  useSearch: boolean;
  useUrlContext: boolean;
} {
  if (options.mode === 'search') {
    return {
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'LOW',
      useSearch: true,
      useUrlContext: false,
    };
  }
  if (options.mode === 'url') {
    return {
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'LOW',
      useSearch: false,
      useUrlContext: true,
    };
  }
  if (options.modelPreset === 'hydrogen-deep') {
    return {
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'XHIGH',
      useSearch: false,
      useUrlContext: false,
    };
  }
  if (options.modelPreset === 'hydrogen-fast') {
    return {
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'LOW',
      useSearch: false,
      useUrlContext: false,
    };
  }
  return {
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'MINIMAL',
    useSearch: false,
    useUrlContext: false,
  };
}

export default function App() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light') return false;
      return true;
    } catch {
      return true;
    }
  });

  const [adaptiveMode, setAdaptiveMode] = useState<AdaptiveMode>(() => {
    try {
      return localStorage.getItem(ADAPTIVE_MODE_KEY) === 'expert'
        ? 'expert'
        : 'learning';
    } catch {
      return 'learning';
    }
  });

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [prefillText, setPrefillText] = useState<string>('');

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);

  const [cloudThreads, setCloudThreads] = useState<ChatThread[]>([]);
  const [cloudMessages, setCloudMessages] = useState<ChatMessage[]>([]);
  const [cloudModules, setCloudModules] = useState<VesperModule[]>([]);

  const [guestThreads, setGuestThreads] = useState<ChatThread[]>(loadGuestThreads);
  const [guestMessagesMap, setGuestMessagesMap] = useState<
    Record<string, ChatMessage[]>
  >(loadGuestMessages);
  const [guestModules, setGuestModules] = useState<VesperModule[]>(loadGuestModules);
  const [builtInToggles, setBuiltInToggles] =
    useState<Record<string, boolean>>(loadBuiltInToggles);

  const [draftThread, setDraftThread] = useState<ChatThread>(() =>
    createEmptyThread(DEFAULT_PREFS)
  );
  const [activeThreadId, setActiveThreadId] = useState<string>(() => draftThread.id);

  const [streamingMessage, setStreamingMessage] = useState<ChatMessage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const isAuthenticated = Boolean(user && user.emailVerified);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    try {
      localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
    } catch {
      // ignore storage errors
    }
  }, [isDark]);

  useEffect(() => {
    try {
      localStorage.setItem(ADAPTIVE_MODE_KEY, adaptiveMode);
    } catch {
      // ignore storage errors
    }
  }, [adaptiveMode]);

  useEffect(() => {
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, []);

  useEffect(() => {
    void testFirestoreConnection();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(GUEST_THREADS_KEY, JSON.stringify(guestThreads));
    } catch {
      // ignore quota errors
    }
  }, [guestThreads]);

  useEffect(() => {
    try {
      const slim: Record<string, ChatMessage[]> = {};
      for (const [tid, list] of Object.entries(guestMessagesMap)) {
        slim[tid] = list.map(
          ({ localAttachments: _la, isStreaming: _is, ...rest }) => rest
        );
      }
      localStorage.setItem(GUEST_MESSAGES_KEY, JSON.stringify(slim));
    } catch {
      // ignore quota errors
    }
  }, [guestMessagesMap]);

  useEffect(() => {
    try {
      localStorage.setItem(GUEST_MODULES_KEY, JSON.stringify(guestModules));
    } catch {
      // ignore storage errors
    }
  }, [guestModules]);

  useEffect(() => {
    try {
      localStorage.setItem(BUILTIN_TOGGLES_KEY, JSON.stringify(builtInToggles));
    } catch {
      // ignore storage errors
    }
  }, [builtInToggles]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser && nextUser.emailVerified) {
        try {
          const loadedPrefs = await ensureUserProfile(nextUser);
          setPrefs(loadedPrefs);
        } catch (err) {
          console.error('Failed to initialize user profile:', err);
        }
      } else {
        setCloudThreads([]);
        setCloudMessages([]);
        setCloudModules([]);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !user || !user.emailVerified) return;
    const unsubThreads = subscribeUserThreads(user.uid, setCloudThreads);
    const unsubModules = subscribeUserModules(user.uid, setCloudModules);
    return () => {
      unsubThreads();
      unsubModules();
    };
  }, [authReady, user]);

  const savedThreads = isAuthenticated ? cloudThreads : guestThreads;
  const customModules = isAuthenticated ? cloudModules : guestModules;

  const builtInModules = useMemo(
    () =>
      BUILT_IN_MODULES.map((m) => ({
        ...m,
        enabled: builtInToggles[m.id] ?? m.enabled,
      })),
    [builtInToggles]
  );

  const allModules = useMemo(
    () => [...builtInModules, ...customModules],
    [builtInModules, customModules]
  );

  const activeModules = useMemo(
    () => allModules.filter((m) => m.enabled),
    [allModules]
  );

  const activeSavedThread = useMemo(
    () => savedThreads.find((t) => t.id === activeThreadId) || null,
    [savedThreads, activeThreadId]
  );

  useEffect(() => {
    if (!authReady || !user || !user.emailVerified || !activeSavedThread) {
      setCloudMessages([]);
      return;
    }
    const unsub = subscribeThreadMessages(user.uid, activeSavedThread.id, (msgs) => {
      setCloudMessages(msgs);
    });
    return () => unsub();
  }, [authReady, user, activeSavedThread]);

  const activeThread: ChatThread = activeSavedThread || draftThread;

  const baseMessages: ChatMessage[] = useMemo(() => {
    if (!activeSavedThread) return [];
    return isAuthenticated
      ? cloudMessages
      : guestMessagesMap[activeSavedThread.id] || [];
  }, [activeSavedThread, isAuthenticated, cloudMessages, guestMessagesMap]);

  const displayedMessages: ChatMessage[] = useMemo(() => {
    if (streamingMessage && streamingMessage.threadId === activeThread.id) {
      const existsInBase = baseMessages.some((m) => m.id === streamingMessage.id);
      if (!existsInBase) {
        return [...baseMessages, streamingMessage];
      }
    }
    return baseMessages;
  }, [baseMessages, streamingMessage, activeThread.id]);

  const recentUserPrompts = useMemo(
    () =>
      baseMessages
        .filter((m) => m.role === 'user' && m.text.trim().length > 0)
        .map((m) => m.text.trim()),
    [baseMessages]
  );

  const userFirstName = useMemo(() => {
    if (!user) return null;
    const rawName = (user.displayName || '').trim();
    if (rawName) {
      return rawName.split(/\s+/)[0].slice(0, 40);
    }
    const emailPrefix = (user.email || '').split('@')[0]?.trim();
    return emailPrefix ? emailPrefix.slice(0, 40) : null;
  }, [user]);

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed.';
      if (!msg.includes('popup-closed-by-user')) {
        setAuthError('Could not complete Google sign-in. Please try again.');
      }
    }
  };

  const handleSignOut = async () => {
    setAuthError(null);
    try {
      await signOutUser();
      const fresh = createEmptyThread(DEFAULT_PREFS);
      setDraftThread(fresh);
      setActiveThreadId(fresh.id);
    } catch {
      setAuthError('Could not sign out.');
    }
  };

  const handleNewThread = useCallback(() => {
    if (isStreaming) {
      abortControllerRef.current?.abort();
    }
    const fresh = createEmptyThread(DEFAULT_PREFS);
    setDraftThread(fresh);
    setActiveThreadId(fresh.id);
    setStreamingMessage(null);
  }, [isStreaming]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (isStreaming) {
        abortControllerRef.current?.abort();
        setIsStreaming(false);
        setStreamingMessage(null);
      }
      setActiveThreadId(threadId);
    },
    [isStreaming]
  );

  const handleRenameThread = async (threadId: string, title: string) => {
    if (isAuthenticated && user) {
      await updateThreadTitle(user.uid, threadId, title);
    } else {
      setGuestThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, title, updatedAtMs: Date.now() } : t
        )
      );
    }
  };

  const handleTogglePin = async (threadId: string, pinned: boolean) => {
    if (isAuthenticated && user) {
      await updateThreadPinned(user.uid, threadId, pinned);
    } else {
      setGuestThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, pinned, updatedAtMs: Date.now() } : t
        )
      );
    }
  };

  const handleDeleteThread = async (threadId: string) => {
    if (isAuthenticated && user) {
      await deleteThreadAndMessages(user.uid, threadId);
    } else {
      setGuestThreads((prev) => prev.filter((t) => t.id !== threadId));
      setGuestMessagesMap((prev) => {
        const copy = { ...prev };
        delete copy[threadId];
        return copy;
      });
    }

    if (activeThreadId === threadId) {
      const fresh = createEmptyThread(DEFAULT_PREFS);
      setDraftThread(fresh);
      setActiveThreadId(fresh.id);
    }
  };

  const handleToggleModule = async (mod: VesperModule) => {
    if (mod.builtIn) {
      setBuiltInToggles((prev) => ({ ...prev, [mod.id]: !mod.enabled }));
      return;
    }
    const updated = { ...mod, enabled: !mod.enabled, updatedAtMs: Date.now() };
    if (isAuthenticated && user) {
      await updateModuleRecord(user.uid, updated);
    } else {
      setGuestModules((prev) => prev.map((m) => (m.id === mod.id ? updated : m)));
    }
  };

  const handleCreateCustomModule = async (input: {
    name: string;
    command: string;
    description: string;
    instruction: string;
  }) => {
    const now = Date.now();
    const newMod: VesperModule = {
      id: generateSafeId('mod'),
      name: input.name,
      command: input.command,
      description: input.description,
      instruction: input.instruction,
      enabled: true,
      builtIn: false,
      createdAtMs: now,
      updatedAtMs: now,
    };
    if (isAuthenticated && user) {
      await createModuleRecord(user.uid, newMod);
    } else {
      setGuestModules((prev) => [...prev, newMod]);
    }
  };

  const handleDeleteCustomModule = async (moduleId: string) => {
    if (isAuthenticated && user) {
      await deleteModuleRecord(user.uid, moduleId);
    } else {
      setGuestModules((prev) => prev.filter((m) => m.id !== moduleId));
    }
  };

  const persistCompletedMessage = async (
    threadSnapshot: ChatThread,
    savedMsg: ChatMessage,
    isFirstTurn: boolean,
    firstUserPrompt: string,
    nextCount: number
  ) => {
    let generatedTitle: string | undefined;
    if (isFirstTurn && savedMsg.text && !savedMsg.error) {
      try {
        const titleRes = await fetch('/api/chat/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userPrompt: firstUserPrompt,
            modelReply: savedMsg.text.slice(0, 600),
          }),
        });
        if (titleRes.ok) {
          const titleData = (await titleRes.json()) as { title?: string };
          if (titleData.title) generatedTitle = titleData.title;
        }
      } catch {
        // keep fallback title
      }
    }

    const previewText = savedMsg.text.replace(/\s+/g, ' ').slice(0, LIMITS.PREVIEW_MAX);

    if (isAuthenticated && user) {
      await createMessageRecord(user.uid, threadSnapshot.id, savedMsg);
      await updateThreadSummary(user.uid, threadSnapshot.id, {
        ...(generatedTitle ? { title: generatedTitle } : {}),
        messageCount: nextCount,
        lastMessagePreview: previewText,
      });
    } else {
      setGuestMessagesMap((prev) => ({
        ...prev,
        [threadSnapshot.id]: [...(prev[threadSnapshot.id] || []), savedMsg],
      }));
      setGuestThreads((prev) =>
        prev.map((t) =>
          t.id === threadSnapshot.id
            ? {
                ...t,
                ...(generatedTitle ? { title: generatedTitle } : {}),
                messageCount: nextCount,
                lastMessagePreview: previewText,
                updatedAtMs: Date.now(),
              }
            : t
        )
      );
    }
  };

  const runGeminiStream = async (
    threadSnapshot: ChatThread,
    conversationMessages: ChatMessage[],
    isFirstTurn: boolean,
    firstUserPrompt: string,
    config: {
      model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
      thinkingLevel: ThinkingDepth;
      useSearch: boolean;
      useUrlContext: boolean;
    }
  ) => {
    const assistantMsgId = generateSafeId('msg');
    const initialModelMsg: ChatMessage = {
      id: assistantMsgId,
      threadId: threadSnapshot.id,
      role: 'model',
      text: '',
      model: config.model,
      createdAtMs: Date.now(),
      isStreaming: true,
    };

    setIsStreaming(true);
    setStreamingMessage(initialModelMsg);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let accumulatedText = '';
    let finalSources: GroundingSource[] | undefined;
    let finalModel: ChatModelId = config.model;
    let finalTotalTokens: number | undefined;
    let finalError: string | undefined;
    let wasAborted = false;

    try {
      const payloadMessages = conversationMessages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.localAttachments && m.localAttachments.length > 0
          ? {
              attachments: m.localAttachments.map((a) => ({
                mimeType: a.mimeType,
                data: a.data,
                name: a.name,
              })),
            }
          : {}),
      }));

      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payloadMessages,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
          useSearch: config.useSearch,
          useUrlContext: config.useUrlContext,
          adaptiveMode,
          userName: userFirstName || undefined,
          activeModules: activeModules.map((m) => ({
            name: m.name,
            command: m.command,
            instruction: m.instruction,
          })),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let errText = `Server returned status ${res.status}`;
        try {
          const errJson = await res.json();
          if (errJson?.error) errText = errJson.error;
        } catch {
          // ignore
        }
        throw new Error(errText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          if (!rawEvent.startsWith('data:')) continue;
          const jsonStr = rawEvent.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const evt = JSON.parse(jsonStr) as {
              type: 'chunk' | 'done' | 'error';
              text?: string;
              error?: string;
              sources?: GroundingSource[];
              totalTokens?: number;
              model?: ChatModelId;
            };

            if (evt.type === 'chunk' && typeof evt.text === 'string') {
              accumulatedText += evt.text;
              setStreamingMessage((prev) =>
                prev ? { ...prev, text: accumulatedText } : prev
              );
            } else if (evt.type === 'done') {
              if (Array.isArray(evt.sources) && evt.sources.length > 0) {
                finalSources = evt.sources;
              }
              if (evt.model) finalModel = evt.model;
              if (typeof evt.totalTokens === 'number') finalTotalTokens = evt.totalTokens;
            } else if (evt.type === 'error') {
              finalError = evt.error || 'Vesper could not reply right now.';
            }
          } catch {
            // ignore malformed SSE chunk
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        wasAborted = true;
      } else {
        finalError =
          err instanceof Error ? err.message : 'Connection failed while replying.';
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }

    if (!accumulatedText && !finalError && !wasAborted) {
      finalError = 'No response was received from Gemini. Please try again.';
    }

    const completedMsg: ChatMessage = {
      id: assistantMsgId,
      threadId: threadSnapshot.id,
      role: 'model',
      text: accumulatedText,
      model: finalModel,
      sources: finalSources,
      totalTokens: finalTotalTokens,
      createdAtMs: Date.now(),
      isStreaming: false,
      error: finalError,
    };

    if (completedMsg.text || (wasAborted && !completedMsg.error)) {
      const textToSave = completedMsg.text || '(Stopped)';
      const savedMsg: ChatMessage = { ...completedMsg, text: textToSave };
      await persistCompletedMessage(
        threadSnapshot,
        savedMsg,
        isFirstTurn,
        firstUserPrompt,
        conversationMessages.length + 1
      );
      setStreamingMessage(null);
    } else {
      setStreamingMessage(completedMsg);
    }
  };

  const handleSend = async (
    rawText: string,
    attachments: AttachmentItem[],
    options: ComposerSendOptions = {
      mode: 'chat',
      modelPreset: 'flash-lite',
    }
  ) => {
    if (isStreaming) return;
    const text = rawText.trim();
    if (!text && attachments.length === 0) return;

    const modelConfig = resolveFreeModelConfig(options);
    const isFirstTurn = !activeSavedThread;
    const targetThread: ChatThread = activeSavedThread
      ? activeSavedThread
      : {
          ...draftThread,
          model: modelConfig.model,
          thinkingLevel: modelConfig.thinkingLevel,
          useSearch: modelConfig.useSearch,
          title: (text || attachments[0]?.name || 'New Chat')
            .replace(/\s+/g, ' ')
            .slice(0, 60),
          messageCount: 1,
          lastMessagePreview: text.slice(0, LIMITS.PREVIEW_MAX),
          updatedAtMs: Date.now(),
        };

    const userMsg: ChatMessage = {
      id: generateSafeId('msg'),
      threadId: targetThread.id,
      role: 'user',
      text: text || `Attached ${attachments.map((a) => a.name).join(', ')}`,
      attachmentNames: attachments.length > 0 ? attachments.map((a) => a.name) : undefined,
      localAttachments: attachments.length > 0 ? attachments : undefined,
      createdAtMs: Date.now(),
    };

    if (isFirstTurn) {
      if (isAuthenticated && user) {
        await createThreadRecord(user.uid, targetThread);
        await createMessageRecord(user.uid, targetThread.id, userMsg);
      } else {
        setGuestThreads((prev) => [targetThread, ...prev]);
        setGuestMessagesMap((prev) => ({
          ...prev,
          [targetThread.id]: [userMsg],
        }));
      }
      setActiveThreadId(targetThread.id);
      setDraftThread(createEmptyThread(prefs));
    } else {
      const nextCount = baseMessages.length + 1;
      if (isAuthenticated && user) {
        await createMessageRecord(user.uid, targetThread.id, userMsg);
        await updateThreadSummary(user.uid, targetThread.id, {
          messageCount: nextCount,
          lastMessagePreview: userMsg.text.slice(0, LIMITS.PREVIEW_MAX),
        });
      } else {
        setGuestMessagesMap((prev) => ({
          ...prev,
          [targetThread.id]: [...(prev[targetThread.id] || []), userMsg],
        }));
        setGuestThreads((prev) =>
          prev.map((t) =>
            t.id === targetThread.id
              ? {
                  ...t,
                  messageCount: nextCount,
                  lastMessagePreview: userMsg.text.slice(0, LIMITS.PREVIEW_MAX),
                  updatedAtMs: Date.now(),
                }
              : t
          )
        );
      }
    }

    const conversationForApi = [...baseMessages, userMsg];
    await runGeminiStream(
      targetThread,
      conversationForApi,
      isFirstTurn,
      userMsg.text,
      modelConfig
    );
  };

  const handleSaveVoiceTranscript = async (
    turns: Array<{ id: string; role: 'user' | 'model'; text: string }>
  ) => {
    if (turns.length === 0) return;

    const isFirstTurn = !activeSavedThread;
    const firstUserText = turns.find((t) => t.role === 'user')?.text || 'Voice Conversation';
    const lastText = turns[turns.length - 1]?.text || '';

    const targetThread: ChatThread = activeSavedThread
      ? activeSavedThread
      : {
          ...draftThread,
          model: 'gemini-3.1-flash-lite',
          thinkingLevel: 'MINIMAL',
          title: `Voice: ${firstUserText.slice(0, 48)}`,
          messageCount: turns.length,
          lastMessagePreview: lastText.slice(0, LIMITS.PREVIEW_MAX),
          updatedAtMs: Date.now(),
        };

    const newMessages: ChatMessage[] = turns.map((turn, idx) => ({
      id: generateSafeId(`vmsg${idx}`),
      threadId: targetThread.id,
      role: turn.role,
      text: turn.text,
      ...(turn.role === 'model' ? { model: 'gemini-3.8-live' as ChatModelId } : {}),
      createdAtMs: Date.now() + idx,
    }));

    if (isAuthenticated && user) {
      if (isFirstTurn) {
        await createThreadRecord(user.uid, targetThread);
      }
      for (const msg of newMessages) {
        await createMessageRecord(user.uid, targetThread.id, msg);
      }
      if (!isFirstTurn) {
        await updateThreadSummary(user.uid, targetThread.id, {
          messageCount: baseMessages.length + newMessages.length,
          lastMessagePreview: lastText.slice(0, LIMITS.PREVIEW_MAX),
        });
      }
    } else {
      if (isFirstTurn) {
        setGuestThreads((prev) => [targetThread, ...prev]);
      } else {
        setGuestThreads((prev) =>
          prev.map((t) =>
            t.id === targetThread.id
              ? {
                  ...t,
                  messageCount: (guestMessagesMap[targetThread.id]?.length || 0) + newMessages.length,
                  lastMessagePreview: lastText.slice(0, LIMITS.PREVIEW_MAX),
                  updatedAtMs: Date.now(),
                }
              : t
          )
        );
      }
      setGuestMessagesMap((prev) => ({
        ...prev,
        [targetThread.id]: [...(prev[targetThread.id] || []), ...newMessages],
      }));
    }

    if (isFirstTurn) {
      setActiveThreadId(targetThread.id);
      setDraftThread(createEmptyThread(prefs));
    }
  };

  const handleRegenerateLast = async () => {
    if (isStreaming || baseMessages.length === 0) return;
    const last = baseMessages[baseMessages.length - 1];
    let historyWithoutLast = baseMessages;
    let wasSearch = activeThread.useSearch;
    let modelToUse: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite' =
      activeThread.model === 'gemini-4-hydrogen' ? 'gemini-4-hydrogen' : 'gemini-3.1-flash-lite';

    if (last.role === 'model') {
      wasSearch = Boolean(last.sources?.length);
      if (last.model === 'gemini-4-hydrogen') modelToUse = 'gemini-4-hydrogen';
      historyWithoutLast = baseMessages.slice(0, -1);
      if (isAuthenticated && user) {
        await deleteMessageRecord(user.uid, activeThread.id, last.id);
      } else {
        setGuestMessagesMap((prev) => ({
          ...prev,
          [activeThread.id]: historyWithoutLast,
        }));
      }
    }
    if (historyWithoutLast.length === 0) return;
    await runGeminiStream(
      activeThread,
      historyWithoutLast,
      false,
      historyWithoutLast[0]?.text || '',
      {
        model: wasSearch ? 'gemini-4-hydrogen' : modelToUse,
        thinkingLevel: activeThread.thinkingLevel,
        useSearch: wasSearch,
        useUrlContext: false,
      }
    );
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-white text-slate-900 dark:bg-[#090a0f] dark:text-[#e3e1e9]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 hidden dark:block"
        style={{
          background:
            'radial-gradient(ellipse 65% 40% at 50% -5%, rgba(139, 92, 246, 0.10), rgba(6, 182, 212, 0.04) 55%, transparent 100%)',
        }}
      />

      <Sidebar
        isOpen={sidebarOpen}
        onCloseMobile={() => setSidebarOpen(false)}
        threads={savedThreads}
        activeThreadId={activeThread.id}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onRenameThread={handleRenameThread}
        onTogglePin={handleTogglePin}
        onDeleteThread={handleDeleteThread}
        user={user}
        authReady={authReady}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
        authError={authError}
      />

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6 dark:border-[#1e2333] dark:bg-[#0f111a]/85 dark:backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-label="Toggle sidebar"
              className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:text-[#94a3b8] dark:hover:bg-[#181b26] dark:hover:text-[#f8fafc]"
            >
              <Menu className="h-4 w-4 lg:hidden" />
              <PanelLeft className="hidden h-4 w-4 lg:block" />
            </button>
            <span className="truncate font-display text-sm font-semibold text-slate-900 dark:text-[#f8fafc]">
              {activeThread.title}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!sidebarOpen && (
              <button
                type="button"
                onClick={handleNewThread}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:border-[#1e2333] dark:bg-[#181b26]/60 dark:text-[#94a3b8] dark:hover:border-[#8b5cf6]/40 dark:hover:text-[#f8fafc] whitespace-nowrap shrink-0"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">New Chat</span>
              </button>
            )}

            <div
              role="group"
              aria-label="Adaptive context mode"
              className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-[#1e2333] dark:bg-[#090a0f]/70"
            >
              <button
                type="button"
                onClick={() => setAdaptiveMode('learning')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  adaptiveMode === 'learning'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-[#181b26] dark:text-[#f8fafc] dark:ring-1 dark:ring-[#8b5cf6]/40'
                    : 'text-slate-500 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:text-[#f8fafc]'
                }`}
              >
                Learning
              </button>
              <button
                type="button"
                onClick={() => setAdaptiveMode('expert')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  adaptiveMode === 'expert'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-[#181b26] dark:text-[#f8fafc] dark:ring-1 dark:ring-[#8b5cf6]/40'
                    : 'text-slate-500 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:text-[#f8fafc]'
                }`}
              >
                Expert
              </button>
            </div>

            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06b6d4] dark:border-[#1e2333] dark:bg-[#181b26]/60 dark:text-[#4cd7f6] dark:hover:border-[#06b6d4]/50 dark:hover:text-[#f8fafc] whitespace-nowrap shrink-0"
            >
              <Radio className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Voice</span>
            </button>

            <button
              type="button"
              onClick={() => setModulesOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:border-[#1e2333] dark:bg-[#181b26]/60 dark:text-[#94a3b8] dark:hover:border-[#8b5cf6]/40 dark:hover:text-[#f8fafc] whitespace-nowrap shrink-0"
            >
              <Boxes className="h-3.5 w-3.5" />
              <span>Modules</span>
            </button>

            <button
              type="button"
              onClick={() => setIsDark((prev) => !prev)}
              aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              title={isDark ? 'Light mode' : 'Dark mode'}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] dark:border-[#1e2333] dark:bg-[#181b26]/60 dark:text-[#94a3b8] dark:hover:border-[#8b5cf6]/40 dark:hover:text-[#f8fafc]"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          <ChatMessageList
            messages={displayedMessages}
            isStreaming={isStreaming}
            userName={userFirstName}
            onSelectStarterPrompt={(prompt) => void handleSend(prompt, [])}
            onRegenerateLast={() => void handleRegenerateLast()}
            onRestorePrompt={(text) => setPrefillText(text)}
          />

          <Composer
            isStreaming={isStreaming}
            activeModules={activeModules}
            recentUserPrompts={recentUserPrompts}
            prefillText={prefillText}
            onConsumePrefill={() => setPrefillText('')}
            onSend={(text, attachments, options) =>
              void handleSend(text, attachments, options)
            }
            onStop={handleStop}
            onOpenVoice={() => setVoiceOpen(true)}
          />
        </main>
      </div>

      <ModulesModal
        isOpen={modulesOpen}
        onClose={() => setModulesOpen(false)}
        builtInModules={builtInModules}
        customModules={customModules}
        onToggleModule={(mod) => void handleToggleModule(mod)}
        onCreateCustomModule={handleCreateCustomModule}
        onDeleteCustomModule={handleDeleteCustomModule}
        onUseCommand={(cmd) => setPrefillText(`${cmd} `)}
      />

      <VoiceSessionModal
        isOpen={voiceOpen}
        adaptiveMode={adaptiveMode}
        userName={userFirstName}
        onClose={() => setVoiceOpen(false)}
        onSaveTranscript={(turns) => void handleSaveVoiceTranscript(turns)}
      />
    </div>
  );
}
