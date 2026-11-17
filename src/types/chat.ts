export type ChatModelId =
  | 'gemini-4-hydrogen'
  | 'gemini-3.1-flash-lite'
  | 'gemini-3.8-live'
  | 'gemini-3.5-transcribe'
  | 'gemini-3.8-flash-lite-tts'
  | 'flux-free';

export type ThinkingDepth = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';

export type AdaptiveMode = 'expert' | 'learning';

export type ComposerMode = 'chat' | 'search' | 'url' | 'image';

export type FreeModelPreset = 'flash-lite' | 'hydrogen-fast' | 'hydrogen-deep';

export interface VesperModule {
  id: string;
  name: string;
  command: string;
  description: string;
  instruction: string;
  enabled: boolean;
  builtIn?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface GroundingSource {
  uri: string;
  title: string;
}

export interface AttachmentItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string; // base64 without data URL prefix
  previewUrl?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'model';
  text: string;
  model?: ChatModelId;
  sources?: GroundingSource[];
  attachmentNames?: string[];
  localAttachments?: AttachmentItem[];
  totalTokens?: number;
  createdAtMs: number;
  isStreaming?: boolean;
  error?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  model: ChatModelId;
  thinkingLevel: ThinkingDepth;
  systemInstruction: string;
  useSearch: boolean;
  pinned: boolean;
  messageCount: number;
  lastMessagePreview: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UserPreferences {
  defaultModel: ChatModelId;
  defaultThinkingLevel: ThinkingDepth;
  defaultSystemInstruction: string;
}
