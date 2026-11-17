import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';
import {
  buildVoiceSystemInstruction,
  getGeminiClient,
  handleChatStream,
  handleChatTitle,
  handleHealth,
  handleTranscribe,
  handleTts,
  mapGeminiError,
  VALID_VOICES,
} from './api/_geminiApp.ts';
import type { AdaptiveMode, ApiRequest, ApiResponse } from './api/_geminiApp.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (req, res) => handleHealth(req as ApiRequest, res as unknown as ApiResponse));
  app.post('/api/chat/stream', (req, res) => handleChatStream(req as ApiRequest, res as unknown as ApiResponse));
  app.post('/api/chat/title', (req, res) => handleChatTitle(req as ApiRequest, res as unknown as ApiResponse));
  app.post('/api/transcribe', (req, res) => handleTranscribe(req as ApiRequest, res as unknown as ApiResponse));
  app.post('/api/tts', (req, res) => handleTts(req as ApiRequest, res as unknown as ApiResponse));

  const httpServer = http.createServer(app);

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
