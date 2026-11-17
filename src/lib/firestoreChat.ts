import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db, handleFirestoreError, OperationType } from './firebase';
import type {
  ChatMessage,
  ChatModelId,
  ChatThread,
  GroundingSource,
  ThinkingDepth,
  UserPreferences,
  VesperModule,
} from '../types/chat';

// Blueprint-synchronized volumetric limits
export const LIMITS = {
  TITLE_MAX: 140,
  SYSTEM_INSTRUCTION_MAX: 4000,
  MESSAGE_TEXT_MAX: 50000,
  PREVIEW_MAX: 240,
  SOURCES_MAX: 15,
  ATTACHMENTS_MAX: 5,
  DISPLAY_NAME_MAX: 100,
  MODULE_NAME_MAX: 60,
  MODULE_COMMAND_MAX: 32,
  MODULE_DESC_MAX: 200,
  MODULE_INST_MAX: 2000,
} as const;

export function generateSafeId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now()}_${random}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

function timestampToMs(val: unknown): number {
  if (val instanceof Timestamp) return val.toMillis();
  if (val && typeof (val as { toMillis?: () => number }).toMillis === 'function') {
    return (val as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

export async function ensureUserProfile(user: User): Promise<UserPreferences> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const defaults: UserPreferences = {
        defaultModel: 'gemini-3.1-flash-lite',
        defaultThinkingLevel: 'MINIMAL',
        defaultSystemInstruction: '',
      };
      await setDoc(ref, {
        uid: user.uid,
        displayName: (user.displayName || user.email?.split('@')[0] || 'User').slice(
          0,
          LIMITS.DISPLAY_NAME_MAX
        ),
        email: (user.email || '').slice(0, 200),
        ...(user.photoURL ? { photoURL: user.photoURL.slice(0, 500) } : {}),
        ...defaults,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return defaults;
    }
    const data = snap.data();
    return {
      defaultModel:
        data.defaultModel === 'gemini-3.1-flash-lite'
          ? 'gemini-3.1-flash-lite'
          : 'gemini-4-hydrogen',
      defaultThinkingLevel: (data.defaultThinkingLevel as ThinkingDepth) || 'HIGH',
      defaultSystemInstruction:
        typeof data.defaultSystemInstruction === 'string'
          ? data.defaultSystemInstruction.slice(0, LIMITS.SYSTEM_INSTRUCTION_MAX)
          : '',
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function saveUserPreferences(
  userId: string,
  prefs: UserPreferences
): Promise<void> {
  const path = `users/${userId}`;
  try {
    await updateDoc(doc(db, 'users', userId), {
      defaultModel: prefs.defaultModel,
      defaultThinkingLevel: prefs.defaultThinkingLevel,
      defaultSystemInstruction: prefs.defaultSystemInstruction.slice(
        0,
        LIMITS.SYSTEM_INSTRUCTION_MAX
      ),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export function subscribeUserThreads(
  userId: string,
  onData: (threads: ChatThread[]) => void
): () => void {
  const path = `users/${userId}/threads`;
  const q = query(
    collection(db, 'users', userId, 'threads'),
    where('ownerId', '==', userId),
    orderBy('updatedAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const threads: ChatThread[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          title: typeof data.title === 'string' ? data.title : 'Untitled Chat',
          model: (data.model as ChatModelId) || 'gemini-4-hydrogen',
          thinkingLevel: (data.thinkingLevel as ThinkingDepth) || 'HIGH',
          systemInstruction:
            typeof data.systemInstruction === 'string' ? data.systemInstruction : '',
          useSearch: Boolean(data.useSearch),
          pinned: Boolean(data.pinned),
          messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
          lastMessagePreview:
            typeof data.lastMessagePreview === 'string' ? data.lastMessagePreview : '',
          createdAtMs: timestampToMs(data.createdAt),
          updatedAtMs: timestampToMs(data.updatedAt),
        };
      });
      onData(threads);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeThreadMessages(
  userId: string,
  threadId: string,
  onData: (messages: ChatMessage[]) => void
): () => void {
  const path = `users/${userId}/threads/${threadId}/messages`;
  const q = query(
    collection(db, 'users', userId, 'threads', threadId, 'messages'),
    where('ownerId', '==', userId),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const messages: ChatMessage[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          threadId,
          role: data.role === 'model' ? 'model' : 'user',
          text: typeof data.text === 'string' ? data.text : '',
          model: data.model as ChatModelId | undefined,
          sources: Array.isArray(data.sources) ? (data.sources as GroundingSource[]) : undefined,
          attachmentNames: Array.isArray(data.attachmentNames)
            ? (data.attachmentNames as string[])
            : undefined,
          totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : undefined,
          createdAtMs: timestampToMs(data.createdAt),
        };
      });
      onData(messages);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function createThreadRecord(
  userId: string,
  thread: ChatThread
): Promise<void> {
  const path = `users/${userId}/threads/${thread.id}`;
  try {
    await setDoc(doc(db, 'users', userId, 'threads', thread.id), {
      ownerId: userId,
      title: (thread.title.trim() || 'New Conversation').slice(0, LIMITS.TITLE_MAX),
      model: thread.model,
      thinkingLevel: thread.thinkingLevel,
      systemInstruction: thread.systemInstruction.slice(0, LIMITS.SYSTEM_INSTRUCTION_MAX),
      useSearch: thread.useSearch,
      pinned: thread.pinned,
      messageCount: Math.max(0, Math.min(5000, Math.floor(thread.messageCount))),
      lastMessagePreview: thread.lastMessagePreview.slice(0, LIMITS.PREVIEW_MAX),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateThreadTitle(
  userId: string,
  threadId: string,
  title: string
): Promise<void> {
  const path = `users/${userId}/threads/${threadId}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'threads', threadId), {
      title: (title.trim() || 'Untitled Chat').slice(0, LIMITS.TITLE_MAX),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateThreadPinned(
  userId: string,
  threadId: string,
  pinned: boolean
): Promise<void> {
  const path = `users/${userId}/threads/${threadId}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'threads', threadId), {
      pinned,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateThreadConfig(
  userId: string,
  threadId: string,
  config: {
    model: ChatModelId;
    thinkingLevel: ThinkingDepth;
    systemInstruction: string;
    useSearch: boolean;
  }
): Promise<void> {
  const path = `users/${userId}/threads/${threadId}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'threads', threadId), {
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      systemInstruction: config.systemInstruction.slice(0, LIMITS.SYSTEM_INSTRUCTION_MAX),
      useSearch: config.useSearch,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateThreadSummary(
  userId: string,
  threadId: string,
  summary: {
    title?: string;
    messageCount: number;
    lastMessagePreview: string;
  }
): Promise<void> {
  const path = `users/${userId}/threads/${threadId}`;
  try {
    const payload: Record<string, unknown> = {
      messageCount: Math.max(0, Math.min(5000, Math.floor(summary.messageCount))),
      lastMessagePreview: summary.lastMessagePreview.slice(0, LIMITS.PREVIEW_MAX),
      updatedAt: serverTimestamp(),
    };
    if (summary.title) {
      payload.title = summary.title.slice(0, LIMITS.TITLE_MAX);
    }
    await updateDoc(doc(db, 'users', userId, 'threads', threadId), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function createMessageRecord(
  userId: string,
  threadId: string,
  message: ChatMessage
): Promise<void> {
  const path = `users/${userId}/threads/${threadId}/messages/${message.id}`;
  try {
    const payload: Record<string, unknown> = {
      ownerId: userId,
      threadId,
      role: message.role,
      text: message.text.slice(0, LIMITS.MESSAGE_TEXT_MAX),
      createdAt: serverTimestamp(),
    };
    if (message.model) {
      payload.model = message.model.slice(0, 64);
    }
    if (message.sources && message.sources.length > 0) {
      payload.sources = message.sources.slice(0, LIMITS.SOURCES_MAX).map((s) => ({
        uri: s.uri.slice(0, 1000),
        title: s.title.slice(0, 300),
      }));
    }
    if (message.attachmentNames && message.attachmentNames.length > 0) {
      payload.attachmentNames = message.attachmentNames
        .slice(0, LIMITS.ATTACHMENTS_MAX)
        .map((n) => n.slice(0, 200));
    }
    if (typeof message.totalTokens === 'number' && Number.isFinite(message.totalTokens)) {
      payload.totalTokens = Math.max(0, Math.min(2000000, Math.floor(message.totalTokens)));
    }
    await setDoc(doc(db, 'users', userId, 'threads', threadId, 'messages', message.id), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function deleteMessageRecord(
  userId: string,
  threadId: string,
  messageId: string
): Promise<void> {
  const path = `users/${userId}/threads/${threadId}/messages/${messageId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'threads', threadId, 'messages', messageId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function deleteThreadAndMessages(
  userId: string,
  threadId: string
): Promise<void> {
  const path = `users/${userId}/threads/${threadId}`;
  try {
    const messagesRef = collection(db, 'users', userId, 'threads', threadId, 'messages');
    const q = query(messagesRef, where('ownerId', '==', userId));
    const snap = await getDocs(q);
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    await deleteDoc(doc(db, 'users', userId, 'threads', threadId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export function subscribeUserModules(
  userId: string,
  onData: (modules: VesperModule[]) => void
): () => void {
  const path = `users/${userId}/modules`;
  const q = query(
    collection(db, 'users', userId, 'modules'),
    where('ownerId', '==', userId),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const modules: VesperModule[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: typeof data.name === 'string' ? data.name : 'Custom Module',
          command: typeof data.command === 'string' ? data.command : '/custom',
          description: typeof data.description === 'string' ? data.description : '',
          instruction: typeof data.instruction === 'string' ? data.instruction : '',
          enabled: Boolean(data.enabled),
          builtIn: false,
          createdAtMs: timestampToMs(data.createdAt),
          updatedAtMs: timestampToMs(data.updatedAt),
        };
      });
      onData(modules);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function createModuleRecord(
  userId: string,
  mod: VesperModule
): Promise<void> {
  const path = `users/${userId}/modules/${mod.id}`;
  try {
    await setDoc(doc(db, 'users', userId, 'modules', mod.id), {
      ownerId: userId,
      name: (mod.name.trim() || 'Custom Module').slice(0, LIMITS.MODULE_NAME_MAX),
      command: mod.command.slice(0, LIMITS.MODULE_COMMAND_MAX),
      description: mod.description.trim().slice(0, LIMITS.MODULE_DESC_MAX),
      instruction: (mod.instruction.trim() || 'Assist the user.').slice(
        0,
        LIMITS.MODULE_INST_MAX
      ),
      enabled: Boolean(mod.enabled),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateModuleRecord(
  userId: string,
  mod: VesperModule
): Promise<void> {
  const path = `users/${userId}/modules/${mod.id}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'modules', mod.id), {
      name: (mod.name.trim() || 'Custom Module').slice(0, LIMITS.MODULE_NAME_MAX),
      command: mod.command.slice(0, LIMITS.MODULE_COMMAND_MAX),
      description: mod.description.trim().slice(0, LIMITS.MODULE_DESC_MAX),
      instruction: (mod.instruction.trim() || 'Assist the user.').slice(
        0,
        LIMITS.MODULE_INST_MAX
      ),
      enabled: Boolean(mod.enabled),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteModuleRecord(
  userId: string,
  moduleId: string
): Promise<void> {
  const path = `users/${userId}/modules/${moduleId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'modules', moduleId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

