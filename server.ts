import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
} from '@google/genai';
import type { Content, LiveServerMessage, Part } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

type ChatModelId = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
type ThinkingDepth = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';

interface IncomingAttachment {
  mimeType: string;
  data: string;
  name?: string;
}

interface IncomingMessage {
  role: 'user' | 'model';
  text: string;
  attachments?: IncomingAttachment[];
}

type AdaptiveMode = 'expert' | 'learning';

interface ActiveModulePayload {
  name: string;
  command: string;
  instruction: string;
}

interface ChatStreamBody {
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

const VALID_VOICES = new Set(['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir']);

const VESPER_BASE_DIRECTIVES = `You are Vesper AI, a highly adaptable and modular AI companion designed for cybersecurity, IT development, and technical problem-solving.

Core Directives:
- Primary Identity: You are Vesper AI. You are witty, friendly, and approachable, while maintaining a high level of professional expertise.
- Cybersecurity Specialization: You act as an ethical hacking assistant, providing threat intelligence, secure coding analysis, and CLI command guidance while strictly adhering to ethical and legal security standards.
- Modular Extensibility: You are designed to accommodate new functions as they are developed. When the user introduces new modules or slash-command functions, integrate them seamlessly into your workflow.
- Safety & Ethics: Your highest priority is system integrity and ethical responsibility. You must refuse any requests that violate security ethics or promote malicious or unauthorized activities.
- Communication: Be concise and efficient when dealing with code or commands, and remain conversational and engaging during brainstorming sessions. Never use em-dashes (—) in your replies; use periods, commas, or standard hyphens instead.
- Continuous Evolution: You are open to receiving new module definitions and workflow updates from the user to expand your capabilities.`;

function sanitizeUserName(raw?: string | null): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function buildSystemInstruction(body: ChatStreamBody): string {
  const mode: AdaptiveMode = body.adaptiveMode === 'expert' ? 'expert' : 'learning';
  const safeUserName = sanitizeUserName(body.userName);
  const modeDirective =
    mode === 'expert'
      ? 'Adaptive Context (Expert Mode): Prioritize deep technical detail, precision, security edge cases, and concise production-ready code or CLI commands without unnecessary introductory fluff.'
      : 'Adaptive Context (Learning Mode): Explain concepts clearly. Connect practical commands and code to underlying networking, OS, or security fundamentals so the user understands both the how and the why.';

  const userDirective = safeUserName
    ? `\nSigned-in User: The user's name is ${safeUserName}. Address them naturally when appropriate.`
    : '';

  const modules = Array.isArray(body.activeModules)
    ? body.activeModules.slice(0, 20)
    : [];
  const modulesSection =
    modules.length > 0
      ? `\nActive Modular Functions (if the user invokes a slash command or asks for one of these workflows, follow its specific directive):\n${modules
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

function buildVoiceSystemInstruction(mode: AdaptiveMode, userName?: string): string {
  const safeUserName = sanitizeUserName(userName);
  const modeNote =
    mode === 'expert'
      ? 'Use Expert Mode: concise, technically sharp spoken explanations.'
      : 'Use Learning Mode: friendly, clear conceptual explanations.';
  const targetUser = safeUserName || 'the user';
  return `You are Vesper AI speaking in real time with ${targetUser}. Be warm, witty, natural, and concise for voice conversation. Keep answers direct and conversational unless asked for step-by-step detail. Maintain strict ethical cybersecurity standards. ${modeNote}`;
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

function getGeminiClient(apiVersion?: string): GoogleGenAI {
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
  // gemini-3.1-flash-lite: default MINIMAL for instant replies
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

function mapGeminiError(err: unknown): { status: number; message: string } {
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
        'Rate limit reached for your current free-tier key. Wait a few seconds and try again.',
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

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
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
      const delayMs = 350 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

function buildContents(messages: IncomingMessage[]): Content[] {
  const contents: Content[] = [];
  for (const msg of messages) {
    const parts: Part[] = [];
    if (Array.isArray(msg.attachments)) {
      for (const att of msg.attachments.slice(0, 5)) {
        if (att && typeof att.data === 'string' && typeof att.mimeType === 'string' && att.data.length > 0) {
          parts.push({
            inlineData: {
              mimeType: att.mimeType,
              data: att.data,
            },
          });
        }
      }
    }
    const trimmedText = typeof msg.text === 'string' ? msg.text : '';
    if (trimmedText.length > 0 || parts.length === 0) {
      parts.push({ text: trimmedText || ' ' });
    }
    contents.push({
      role: msg.role === 'model' ? 'model' : 'user',
      parts,
    });
  }
  return contents;
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/chat/stream', async (req: Request, res: Response) => {
    const body = (req.body || {}) as ChatStreamBody;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];

    if (rawMessages.length === 0) {
      res.status(400).json({ error: 'At least one message is required.' });
      return;
    }

    const latestMessage = rawMessages[rawMessages.length - 1];
    const latestText = typeof latestMessage?.text === 'string' ? latestMessage.text : '';
    const useSearch = Boolean(body.useSearch) || shouldAutoSearch(latestText);
    const useUrlContext = Boolean(body.useUrlContext) || containsWebUrl(latestText);
    const model: ChatModelId =
      useSearch || useUrlContext ? 'gemini-4-hydrogen' : resolveModel(body.model);
    const thinkingLevel = resolveThinkingLevel(model, body.thinkingLevel);
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

      const stream = await withRetry(() =>
        ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel },
            ...(tools.length > 0 ? { tools } : {}),
          },
        })
      );

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
          model,
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
  });

  app.post('/api/chat/title', async (req: Request, res: Response) => {
    const body = (req.body || {}) as TitleRequestBody;
    const userPrompt = typeof body.userPrompt === 'string' ? body.userPrompt.trim().slice(0, 1000) : '';
    const modelReply = typeof body.modelReply === 'string' ? body.modelReply.trim().slice(0, 1000) : '';

    if (!userPrompt) {
      res.status(400).json({ error: 'userPrompt is required.' });
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
      res.json({ title });
    } catch (err) {
      const mapped = mapGeminiError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post('/api/transcribe', async (req: Request, res: Response) => {
    const body = (req.body || {}) as TranscribeRequestBody;
    const audioData = typeof body.audioData === 'string' ? body.audioData.trim() : '';
    const rawMime = typeof body.mimeType === 'string' ? body.mimeType.split(';')[0].trim() : '';
    const mimeType = rawMime.startsWith('audio/') ? rawMime : 'audio/webm';

    if (!audioData) {
      res.status(400).json({ error: 'Recorded audio data is required.' });
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

      res.json({
        transcript,
        model: usedModel,
      });
    } catch (err) {
      const mapped = mapGeminiError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post('/api/tts', async (req: Request, res: Response) => {
    const body = (req.body || {}) as TtsRequestBody;
    const rawText = typeof body.text === 'string' ? body.text : '';
    const cleanText = rawText
      .replace(/```[\s\S]*?```/g, ' Code snippet omitted. ')
      .replace(/[#*_`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3500);

    if (!cleanText) {
      res.status(400).json({ error: 'Text is required for speech playback.' });
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
        res.status(502).json({ error: 'No audio was returned by gemini-3.8-flash-lite-tts.' });
        return;
      }

      res.json({
        audioDataUrl: `data:audio/wav;base64,${base64Audio}`,
        model: 'gemini-3.8-flash-lite-tts',
      });
    } catch (err) {
      const mapped = mapGeminiError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const urlPath = (request.url || '').split('?')[0];
    if (urlPath === '/api/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (clientWs, req) => {
    const sendJson = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let closedByClient = false;
    let sentError = false;
    const pingTimer = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.ping();
        } catch {
          // ignore ping errors
        }
      }
    }, 25000);

    const reqUrl = new URL(req.url || '/api/live', `http://${req.headers.host || 'localhost'}`);
    const mode: AdaptiveMode = reqUrl.searchParams.get('mode') === 'expert' ? 'expert' : 'learning';
    const rawVoice = reqUrl.searchParams.get('voice') || 'Zephyr';
    const voiceName = VALID_VOICES.has(rawVoice) ? rawVoice : 'Zephyr';
    const userName = reqUrl.searchParams.get('userName') || '';

    clientWs.on('close', () => {
      closedByClient = true;
      clearInterval(pingTimer);
      try {
        session?.close();
      } catch {
        // ignore close errors
      }
    });

    try {
      const ai = getGeminiClient('v1beta');
      session = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: buildVoiceSystemInstruction(mode, userName),
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const content = message.serverContent;
            if (content?.inputTranscription?.text) {
              sendJson({
                type: 'inputTranscript',
                text: content.inputTranscription.text,
              });
            }
            if (content?.outputTranscription?.text) {
              sendJson({
                type: 'outputTranscript',
                text: content.outputTranscription.text,
              });
            }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                sendJson({ type: 'audio', data: part.inlineData.data });
              }
            }
            if (content?.interrupted) {
              sendJson({ type: 'interrupted' });
            }
            if (content?.turnComplete) {
              sendJson({ type: 'turnComplete' });
            }
          },
          onerror: (err: unknown) => {
            const mapped = mapGeminiError(err);
            sentError = true;
            sendJson({ type: 'error', error: mapped.message });
          },
          onclose: (closeEvt?: { code?: number; reason?: string }) => {
            if (
              !closedByClient &&
              !sentError &&
              closeEvt?.code &&
              closeEvt.code !== 1000 &&
              closeEvt.code !== 1005 &&
              closeEvt.reason
            ) {
              sentError = true;
              sendJson({ type: 'error', error: closeEvt.reason });
            } else {
              sendJson({ type: 'closed' });
            }
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.close();
            }
          },
        },
      });

      if (closedByClient) {
        session.close();
        return;
      }

      sendJson({ type: 'ready' });

      clientWs.on('message', (raw) => {
        if (!session) return;
        try {
          const parsed = JSON.parse(raw.toString()) as {
            type?: string;
            data?: string;
            text?: string;
          };
          if (parsed.type === 'audio' && typeof parsed.data === 'string' && parsed.data.length > 0) {
            session.sendRealtimeInput({
              audio: { data: parsed.data, mimeType: 'audio/pcm;rate=16000' },
            });
          } else if (parsed.type === 'text' && typeof parsed.text === 'string' && parsed.text.trim()) {
            session.sendRealtimeInput({ text: parsed.text.trim() });
          }
        } catch {
          // ignore malformed ws frames
        }
      });
    } catch (err) {
      if (!sentError) {
        const mapped = mapGeminiError(err);
        sendJson({ type: 'error', error: mapped.message });
      }
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
