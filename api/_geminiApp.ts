import {
  GoogleGenAI,
  ThinkingLevel,
} from '@google/genai';
import type { Content, Part } from '@google/genai';
import type { IncomingMessage as NodeIncomingMessage, ServerResponse as NodeServerResponse } from 'node:http';

export type ApiRequest = NodeIncomingMessage & {
  body?: unknown;
  method?: string;
};

export type ApiResponse = NodeServerResponse & {
  status?: (code: number) => ApiResponse;
  json?: (body: unknown) => ApiResponse;
  flushHeaders?: () => void;
};

export type ChatModelId = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
export type ThinkingDepth = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';
export type AdaptiveMode = 'expert' | 'learning';

export interface IncomingAttachment {
  mimeType: string;
  data: string;
  name?: string;
}

export interface IncomingMessage {
  role: 'user' | 'model';
  text: string;
  attachments?: IncomingAttachment[];
}

export interface ActiveModulePayload {
  name: string;
  command: string;
  instruction: string;
}

export interface ChatStreamBody {
  messages?: IncomingMessage[];
  model?: string;
  thinkingLevel?: string;
  systemInstruction?: string;
  adaptiveMode?: AdaptiveMode;
  activeModules?: ActiveModulePayload[];
  useSearch?: boolean;
  useUrlContext?: boolean;
  userName?: string;
}

interface TitleRequestBody {
  userPrompt?: string;
  modelReply?: string;
}

interface TranscribeRequestBody {
  audioData?: string;
  mimeType?: string;
}

interface TtsRequestBody {
  text?: string;
  voice?: string;
}

interface GroundingSource {
  uri: string;
  title: string;
}

const VALID_MODELS: ReadonlySet<ChatModelId> = new Set([
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
]);

export const VALID_VOICES = new Set(['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir']);

const VESPER_BASE_DIRECTIVES = `You are Vesper AI, a helpful, intelligent, and versatile all-rounder AI assistant.

Core Directives:
- Primary Identity: You are Vesper AI. Speak in a warm, natural, friendly, and clear everyday tone, much like a thoughtful assistant who adapts smoothly to whatever the user needs.
- All-Rounder Capabilities: Help across any topic, including everyday questions, writing and editing, summarizing documents, analyzing images and screenshots, brainstorming, studying and learning, math, research, productivity, coding, and tech support.
- Modular Extensibility: When the user invokes slash-command modules or custom instructions, follow them seamlessly.
- Safety & Honesty: Be accurate, honest when unsure, and responsible. Avoid harmful or unethical assistance while keeping regular conversations natural and welcoming.
- Communication: Match the user's pace and tone. Keep quick questions concise and direct, and give clear step-by-step explanations when teaching or solving problems. Never use em-dashes (—) in your replies; use periods, commas, or standard hyphens instead.`;

function sanitizeUserName(raw?: string | null): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function buildSystemInstruction(body: ChatStreamBody): string {
  const mode: AdaptiveMode = body.adaptiveMode === 'expert' ? 'expert' : 'learning';
  const safeUserName = sanitizeUserName(body.userName);
  const modeDirective =
    mode === 'expert'
      ? 'Adaptive Context (Expert Mode): Be concise, thorough, and direct. Prioritize high-signal answers, technical precision, and clean code or structured analysis without extra fluff.'
      : 'Adaptive Context (Learning Mode): Explain ideas clearly in plain, approachable language. Use helpful examples and connect concepts so the user easily understands both the answer and why it works.';

  const userDirective = safeUserName
    ? `\nSigned-in User: The user's name is ${safeUserName}. Address them naturally when appropriate.`
    : '';

  const modules = Array.isArray(body.activeModules)
    ? body.activeModules.slice(0, 20)
    : [];
  const modulesSection =
    modules.length > 0
      ? `\nActive Assistant Modules (if the user invokes a slash command or asks for one of these workflows, follow its specific directive):\n${modules
          .map(
            (m) =>
              `- ${String(m.command || '').slice(0, 32)} (${String(m.name || '').slice(0, 60)}): ${String(m.instruction || '').slice(0, 600)}`
          )
          .join('\n')}`
      : '';

  const customExtra =
    typeof body.systemInstruction === 'string' && body.systemInstruction.trim().length > 0
      ? `\nAdditional User Context:\n${body.systemInstruction.trim().slice(0, 1500)}`
      : '';

  return `${VESPER_BASE_DIRECTIVES}\n\n${modeDirective}${userDirective}${modulesSection}${customExtra}`.slice(
    0,
    4000
  );
}

export function buildVoiceSystemInstruction(mode: AdaptiveMode, userName?: string): string {
  const safeUserName = sanitizeUserName(userName);
  const modeNote =
    mode === 'expert'
      ? 'Keep answers concise, direct, and well-informed.'
      : 'Keep answers friendly, clear, and easy to follow.';
  const targetUser = safeUserName || 'the user';
  return `You are Vesper AI, a helpful all-rounder AI assistant speaking in real time with ${targetUser}. Be warm, natural, and conversational for voice chat. Answer any everyday, creative, study, or technical question directly unless asked for step-by-step detail. Never use em-dashes. ${modeNote}`;
}

function shouldAutoSearch(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  if (normalized.startsWith('/search')) return true;
  const liveSignals = [
    /\b(latest|recent|current|currently|today|tonight|yesterday|this week|this month|this year|2025|2026|now)\b/,
    /\b(news|weather|forecast|stock|price|score|standings|release notes|changelog|cve-\d{4}|zero-day|advisory|breach|outage)\b/,
    /\b(who won|who is the current|what happened|search the web|look up|check online)\b/,
  ];
  return liveSignals.some((rx) => rx.test(normalized));
}

function containsWebUrl(text: string): boolean {
  return /https?:\/\/[^\s]+/i.test(text);
}

export function getGeminiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error('GEMINI_API_KEY is missing. Please configure it in Settings > Secrets.'),
      { status: 400 }
    );
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function resolveModel(raw?: string): ChatModelId {
  if (raw && VALID_MODELS.has(raw as ChatModelId)) {
    return raw as ChatModelId;
  }
  return 'gemini-3.1-flash-lite';
}

function resolveThinkingLevel(model: ChatModelId, raw?: string): ThinkingLevel {
  const requested = (raw || '').toUpperCase() as ThinkingDepth;
  if (model === 'gemini-4-hydrogen') {
    switch (requested) {
      case 'LOW':
        return ThinkingLevel.LOW;
      case 'MEDIUM':
        return ThinkingLevel.MEDIUM;
      case 'HIGH':
        return ThinkingLevel.HIGH;
      case 'XHIGH':
        return ThinkingLevel.XHIGH;
      case 'MINIMAL':
      default:
        return ThinkingLevel.LOW;
    }
  }
  switch (requested) {
    case 'LOW':
      return ThinkingLevel.LOW;
    case 'MEDIUM':
      return ThinkingLevel.MEDIUM;
    case 'HIGH':
    case 'XHIGH':
      return ThinkingLevel.HIGH;
    case 'MINIMAL':
    default:
      return ThinkingLevel.MINIMAL;
  }
}

export function mapGeminiError(err: unknown): { status: number; message: string } {
  const anyErr = err as { status?: number; code?: number; message?: string };
  const rawMessage = anyErr?.message || 'Unexpected error communicating with Gemini.';
  const status = Number(anyErr?.status || anyErr?.code || 500);

  if (status === 403 || rawMessage.includes('PERMISSION_DENIED')) {
    return {
      status: 403,
      message: 'API permission denied. Please verify your GEMINI_API_KEY in Settings > Secrets.',
    };
  }
  if (status === 400 || rawMessage.includes('API_KEY_INVALID')) {
    return {
      status: 400,
      message: rawMessage.includes('API_KEY_INVALID')
        ? 'Invalid Gemini API key. Please check Settings > Secrets.'
        : rawMessage,
    };
  }
  if (status === 429 || rawMessage.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Free-tier rate limit reached (large files or rapid messages can hit per-minute quotas). Wait ~20 seconds and try again.',
    };
  }
  if (status === 404 || rawMessage.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: 'Requested Gemini model was not found or is currently unavailable.',
    };
  }
  return {
    status: Number.isFinite(status) && status >= 400 && status < 600 ? status : 500,
    message: rawMessage,
  };
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 800
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const mapped = mapGeminiError(err);
      const isTransient = mapped.status === 503 || mapped.status === 500 || mapped.status === 429;
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

function buildContents(messages: IncomingMessage[]): Content[] {
  const seenKeys = new Set<string>();
  const keptAttachmentsByIndex: IncomingAttachment[][] = messages.map(() => []);
  const omittedNamesByIndex: string[][] = messages.map(() => []);

  for (let i = messages.length - 1; i >= 0; i--) {
    const atts = Array.isArray(messages[i]?.attachments) ? messages[i].attachments!.slice(0, 5) : [];
    for (const att of atts) {
      if (!att || typeof att.data !== 'string' || typeof att.mimeType !== 'string' || att.data.length === 0) {
        continue;
      }
      const key = `${att.mimeType}:${att.data.length}:${att.data.slice(0, 64)}`;
      if (seenKeys.has(key)) {
        if (att.name) omittedNamesByIndex[i].push(att.name);
        continue;
      }
      seenKeys.add(key);
      keptAttachmentsByIndex[i].push(att);
    }
  }

  const contents: Content[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const parts: Part[] = [];
    for (const att of keptAttachmentsByIndex[i]) {
      parts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: att.data,
        },
      });
    }
    const baseText = typeof msg.text === 'string' ? msg.text : '';
    const omittedNote =
      omittedNamesByIndex[i].length > 0
        ? `\n[Attached file included later in conversation: ${omittedNamesByIndex[i].join(', ')}]`
        : '';
    const combinedText = `${baseText}${omittedNote}`.trim();
    if (combinedText.length > 0 || parts.length === 0) {
      parts.push({ text: combinedText || ' ' });
    }
    contents.push({
      role: msg.role === 'model' ? 'model' : 'user',
      parts,
    });
  }
  return contents;
}

function sendJson(res: ApiResponse, statusCode: number, payload: unknown) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(statusCode);
    res.json(payload);
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function getParsedBody<T>(req: ApiRequest): Promise<T> {
  const raw = req.body;
  if (raw !== undefined && raw !== null) {
    if (Buffer.isBuffer(raw)) {
      const str = raw.toString('utf8').trim();
      if (!str) return {} as T;
      try {
        return JSON.parse(str) as T;
      } catch {
        return {} as T;
      }
    }
    if (typeof raw === 'string') {
      const str = raw.trim();
      if (!str) return {} as T;
      try {
        return JSON.parse(str) as T;
      } catch {
        return {} as T;
      }
    }
    if (typeof raw === 'object') {
      return raw as T;
    }
  }

  if (req.readableEnded) {
    return {} as T;
  }

  return await new Promise<T>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const maxBytes = 20 * 1024 * 1024;
    let settled = false;

    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        finish({} as T);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        finish({} as T);
        return;
      }
      try {
        finish(JSON.parse(text) as T);
      } catch {
        finish({} as T);
      }
    });

    req.on('error', () => {
      finish({} as T);
    });
  });
}

export function handleHealth(_req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, { ok: true });
}

export async function handleChatStream(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const body = await getParsedBody<ChatStreamBody>(req);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  if (rawMessages.length === 0) {
    sendJson(res, 400, { error: 'At least one message is required.' });
    return;
  }

  const latestMessage = rawMessages[rawMessages.length - 1];
  const latestText = typeof latestMessage?.text === 'string' ? latestMessage.text : '';
  const useSearch = Boolean(body.useSearch) || shouldAutoSearch(latestText);
  const useUrlContext = Boolean(body.useUrlContext) || containsWebUrl(latestText);
  const model: ChatModelId =
    useSearch || useUrlContext ? 'gemini-4-hydrogen' : resolveModel(body.model);
  const systemInstruction = buildSystemInstruction(body);

  const tools: Array<Record<string, unknown>> = [];
  if (useSearch) tools.push({ googleSearch: {} });
  if (useUrlContext) tools.push({ urlContext: {} });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
    }
  });

  const writeEvent = (payload: Record<string, unknown>) => {
    if (clientClosed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const ai = getGeminiClient();
    const contents = buildContents(rawMessages);

    const openStream = (targetModel: ChatModelId, includeTools: boolean) =>
      ai.models.generateContentStream({
        model: targetModel,
        contents,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: resolveThinkingLevel(targetModel, body.thinkingLevel) },
          ...(includeTools && tools.length > 0 ? { tools } : {}),
        },
      });

    let activeModel: ChatModelId = model;
    let stream;
    try {
      stream = await withRetry(
        () => openStream(activeModel, true),
        activeModel === 'gemini-4-hydrogen' ? 1 : 2,
        activeModel === 'gemini-4-hydrogen' ? 1200 : 1500
      );
    } catch (primaryErr) {
      const primaryMapped = mapGeminiError(primaryErr);
      if (
        activeModel === 'gemini-4-hydrogen' &&
        (primaryMapped.status === 429 || primaryMapped.status === 503 || primaryMapped.status === 404)
      ) {
        activeModel = 'gemini-3.1-flash-lite';
        try {
          stream = await withRetry(() => openStream(activeModel, true), 1, 1200);
        } catch (fallbackWithToolsErr) {
          const fallbackMapped = mapGeminiError(fallbackWithToolsErr);
          if (tools.length > 0 && (fallbackMapped.status === 400 || fallbackMapped.status === 429)) {
            stream = await withRetry(() => openStream(activeModel, false), 1, 1200);
          } else {
            throw fallbackWithToolsErr;
          }
        }
      } else {
        throw primaryErr;
      }
    }

    const sourceMap = new Map<string, GroundingSource>();
    let totalTokens: number | undefined;

    for await (const chunk of stream) {
      if (clientClosed) break;

      if (chunk.text) {
        writeEvent({ type: 'chunk', text: chunk.text });
      }

      const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (Array.isArray(groundingChunks)) {
        for (const gc of groundingChunks) {
          const web = gc?.web;
          if (web?.uri) {
            sourceMap.set(web.uri, {
              uri: web.uri,
              title: (web.title || web.uri).slice(0, 300),
            });
          }
        }
      }

      const urlMeta = chunk.candidates?.[0]?.urlContextMetadata?.urlMetadata;
      if (Array.isArray(urlMeta)) {
        for (const item of urlMeta) {
          if (item?.retrievedUrl) {
            sourceMap.set(item.retrievedUrl, {
              uri: item.retrievedUrl,
              title: item.retrievedUrl.slice(0, 300),
            });
          }
        }
      }

      if (typeof chunk.usageMetadata?.totalTokenCount === 'number') {
        totalTokens = chunk.usageMetadata.totalTokenCount;
      }
    }

    if (!clientClosed) {
      writeEvent({
        type: 'done',
        sources: Array.from(sourceMap.values()).slice(0, 15),
        totalTokens,
        model: activeModel,
      });
    }
  } catch (err) {
    const mapped = mapGeminiError(err);
    writeEvent({
      type: 'error',
      error: mapped.message,
      code: mapped.status,
    });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

export async function handleChatTitle(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const body = await getParsedBody<TitleRequestBody>(req);
  const userPrompt = typeof body.userPrompt === 'string' ? body.userPrompt.trim().slice(0, 1000) : '';
  const modelReply = typeof body.modelReply === 'string' ? body.modelReply.trim().slice(0, 1000) : '';

  if (!userPrompt) {
    sendJson(res, 400, { error: 'userPrompt is required.' });
    return;
  }

  try {
    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: `Generate a concise 3 to 6 word title (no quotes, no trailing punctuation, title case) summarizing this conversation:\n\nUser: ${userPrompt}\nAssistant: ${modelReply}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
    const rawTitle = (response.text || '').replace(/["'*`#]/g, '').trim();
    const title = rawTitle.slice(0, 100) || userPrompt.slice(0, 50);
    sendJson(res, 200, { title });
  } catch (err) {
    const mapped = mapGeminiError(err);
    sendJson(res, mapped.status, { error: mapped.message });
  }
}

export async function handleTranscribe(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const body = await getParsedBody<TranscribeRequestBody>(req);
  const audioData = typeof body.audioData === 'string' ? body.audioData.trim() : '';
  const rawMime = typeof body.mimeType === 'string' ? body.mimeType.split(';')[0].trim() : '';
  const mimeType = rawMime.startsWith('audio/') ? rawMime : 'audio/webm';

  if (!audioData) {
    sendJson(res, 400, { error: 'Recorded audio data is required.' });
    return;
  }

  const transcribeContents = {
    parts: [
      {
        inlineData: {
          mimeType,
          data: audioData,
        },
      },
      {
        text: 'Transcribe this audio.',
      },
    ],
  };

  try {
    const aiAlpha = getGeminiClient('v1alpha');
    const aiDefault = getGeminiClient();
    let usedModel = 'gemini-3.5-transcribe';
    let response;

    try {
      response = await withRetry(() =>
        aiAlpha.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: transcribeContents,
        })
      );
    } catch (primaryErr) {
      const primaryMapped = mapGeminiError(primaryErr);
      if (primaryMapped.status === 404) {
        usedModel = 'gemini-3.1-flash-lite';
        response = await withRetry(() =>
          aiDefault.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: transcribeContents,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            },
          })
        );
      } else {
        throw primaryErr;
      }
    }

    let transcript = (response.text || '').trim();
    if (!transcript && usedModel === 'gemini-3.5-transcribe') {
      usedModel = 'gemini-3.1-flash-lite';
      const fallbackRes = await withRetry(() =>
        aiDefault.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: {
            parts: [
              transcribeContents.parts[0],
              {
                text: 'Transcribe the spoken words in this audio accurately. Return only the spoken words without timestamps or commentary. If there is no speech, output [NO_SPEECH].',
              },
            ],
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        })
      );
      transcript = (fallbackRes.text || '').trim();
    }

    if (
      /^\[?no[_\s-]?speech\]?$/i.test(transcript) ||
      /^\d{2}:\d{2}(:\d{2})?$/.test(transcript)
    ) {
      transcript = '';
    }

    sendJson(res, 200, {
      transcript,
      model: usedModel,
    });
  } catch (err) {
    const mapped = mapGeminiError(err);
    sendJson(res, mapped.status, { error: mapped.message });
  }
}

export async function handleTts(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const body = await getParsedBody<TtsRequestBody>(req);
  const rawText = typeof body.text === 'string' ? body.text : '';
  const cleanText = rawText
    .replace(/```[\s\S]*?```/g, ' Code snippet omitted. ')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500);

  if (!cleanText) {
    sendJson(res, 400, { error: 'Text is required for speech playback.' });
    return;
  }

  const voiceName =
    typeof body.voice === 'string' && VALID_VOICES.has(body.voice)
      ? body.voice
      : 'Zephyr';

  try {
    const aiAlpha = getGeminiClient('v1alpha');
    const response = await withRetry(() =>
      aiAlpha.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: cleanText,
                speechMetadata: {
                  style: 'Clear, friendly, conversational assistant',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      })
    );

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      sendJson(res, 502, { error: 'No audio was returned by gemini-3.8-flash-lite-tts.' });
      return;
    }

    sendJson(res, 200, {
      audioDataUrl: `data:audio/wav;base64,${base64Audio}`,
      model: 'gemini-3.8-flash-lite-tts',
    });
  } catch (err) {
    const mapped = mapGeminiError(err);
    sendJson(res, mapped.status, { error: mapped.message });
  }
}

interface ImageGenerateRequestBody {
  prompt?: string;
  width?: number;
  height?: number;
  seed?: number;
}

export async function handleImageGenerate(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const body = await getParsedBody<ImageGenerateRequestBody>(req);
  const rawPrompt = typeof body.prompt === 'string' ? body.prompt : '';
  const prompt = rawPrompt.replace(/\s+/g, ' ').trim().slice(0, 800);

  if (!prompt) {
    sendJson(res, 400, { error: 'An image description prompt is required.' });
    return;
  }

  const width =
    typeof body.width === 'number' && body.width >= 256 && body.width <= 1024
      ? Math.round(body.width)
      : 768;
  const height =
    typeof body.height === 'number' && body.height >= 256 && body.height <= 1024
      ? Math.round(body.height)
      : 768;
  const seed =
    typeof body.seed === 'number' && Number.isFinite(body.seed)
      ? Math.abs(Math.floor(body.seed))
      : Math.floor(Math.random() * 1_000_000_000);

  const modelsToTry = ['flux', 'turbo'] as const;
  let lastStatus = 502;
  let lastError = 'Image generator did not return an image.';

  for (const modelVariant of modelsToTry) {
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      prompt
    )}?width=${width}&height=${height}&model=${modelVariant}&seed=${seed}&nologo=true`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);

    try {
      const upstream = await fetch(imageUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);

      const contentType = upstream.headers.get('content-type') || '';
      if (upstream.ok && contentType.startsWith('image/')) {
        // Consume body briefly so the upstream generation caches cleanly for the client browser.
        await upstream.arrayBuffer();
        sendJson(res, 200, {
          imageUrl,
          prompt,
          seed,
          model: 'flux-free',
        });
        return;
      }

      lastStatus = upstream.status || 502;
      lastError = `Image service returned status ${lastStatus}.`;
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = (err as { name?: string })?.name === 'AbortError';
      lastStatus = isTimeout ? 504 : 502;
      lastError = isTimeout
        ? 'Image generation timed out. Please try a shorter prompt.'
        : 'Could not reach the free image generation service.';
    }
  }

  sendJson(res, lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, {
    error: lastError,
  });
}

