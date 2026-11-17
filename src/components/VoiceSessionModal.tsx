import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import type { AdaptiveMode } from '../types/chat';

interface VoiceTurn {
  id: string;
  role: 'user' | 'model';
  text: string;
}

interface VoiceSessionModalProps {
  isOpen: boolean;
  adaptiveMode: AdaptiveMode;
  userName?: string | null;
  onClose: () => void;
  onSaveTranscript?: (turns: VoiceTurn[]) => void;
}

const VOICES = ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'] as const;

function float32ToPcmBase64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function pcmBase64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma !== -1 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to encode recorded audio.'));
    reader.readAsDataURL(blob);
  });
}

export function VoiceSessionModal({
  isOpen,
  adaptiveMode,
  userName,
  onClose,
  onSaveTranscript,
}: VoiceSessionModalProps) {
  const [voice, setVoice] = useState<(typeof VOICES)[number]>('Zephyr');
  const [transportMode, setTransportMode] = useState<'live' | 'turn'>('live');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [isTurnRecording, setIsTurnRecording] = useState(false);
  const [isTurnProcessing, setIsTurnProcessing] = useState(false);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const isMutedRef = useRef<boolean>(false);
  const isLiveReadyRef = useRef<boolean>(false);
  const transportModeRef = useRef<'live' | 'turn'>('live');
  const voiceRef = useRef<(typeof VOICES)[number]>('Zephyr');
  const turnsRef = useRef<VoiceTurn[]>([]);

  const turnRecorderRef = useRef<MediaRecorder | null>(null);
  const turnChunksRef = useRef<BlobPart[]>([]);
  const turnAudioRef = useRef<HTMLAudioElement | null>(null);
  const turnAbortRef = useRef<AbortController | null>(null);
  const closingSessionRef = useRef<boolean>(false);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  useEffect(() => {
    transportModeRef.current = transportMode;
  }, [transportMode]);

  const stopPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // ignore already-stopped nodes
      }
    }
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    if (turnAudioRef.current) {
      try {
        turnAudioRef.current.pause();
        turnAudioRef.current.currentTime = 0;
      } catch {
        // ignore audio stop errors
      }
      turnAudioRef.current = null;
    }

    setIsModelSpeaking(false);
  }, []);

  const cleanupLiveAudioPipeline = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      try {
        processorRef.current.disconnect();
      } catch {
        // ignore
      }
      processorRef.current = null;
    }

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      sourceNodeRef.current = null;
    }

    if (inputCtxRef.current) {
      void inputCtxRef.current.close().catch(() => undefined);
      inputCtxRef.current = null;
    }

    if (outputCtxRef.current) {
      void outputCtxRef.current.close().catch(() => undefined);
      outputCtxRef.current = null;
    }

    if (wsRef.current) {
      try {
        if (
          wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING
        ) {
          wsRef.current.close();
        }
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
  }, []);

  const cleanupResources = useCallback(() => {
    closingSessionRef.current = true;
    isLiveReadyRef.current = false;
    stopPlayback();

    if (turnAbortRef.current) {
      turnAbortRef.current.abort();
      turnAbortRef.current = null;
    }

    if (turnRecorderRef.current && turnRecorderRef.current.state !== 'inactive') {
      try {
        turnRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    turnRecorderRef.current = null;
    turnChunksRef.current = [];
    setIsTurnRecording(false);
    setIsTurnProcessing(false);

    cleanupLiveAudioPipeline();

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [cleanupLiveAudioPipeline, stopPlayback]);

  const appendTurnChunk = useCallback((role: 'user' | 'model', chunk: string) => {
    const clean = chunk.replace(/—/g, '-');
    if (!clean.trim()) return;
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        const needsSpace =
          !last.text.endsWith(' ') && !clean.startsWith(' ') && !/^[,.'!?]/.test(clean);
        const merged = `${last.text}${needsSpace ? ' ' : ''}${clean}`;
        return [...prev.slice(0, -1), { ...last, text: merged }];
      }
      return [
        ...prev,
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          role,
          text: clean.trim(),
        },
      ];
    });
  }, []);

  const setModelTurnText = useCallback((turnId: string, fullText: string) => {
    const clean = fullText.replace(/—/g, '-');
    setTurns((prev) => {
      const idx = prev.findIndex((t) => t.id === turnId);
      if (idx === -1) {
        return [...prev, { id: turnId, role: 'model', text: clean }];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], text: clean };
      return next;
    });
  }, []);

  const scheduleAudioChunk = useCallback((base64Pcm: string) => {
    const ctx = outputCtxRef.current;
    if (!ctx) return;

    const float32 = pcmBase64ToFloat32(base64Pcm);
    if (float32.length === 0) return;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, nextStartTimeRef.current);
    nextStartTimeRef.current = startAt + buffer.duration;

    activeSourcesRef.current.add(src);
    setIsModelSpeaking(true);

    src.onended = () => {
      activeSourcesRef.current.delete(src);
      if (activeSourcesRef.current.size === 0) {
        setIsModelSpeaking(false);
      }
    };

    src.start(startAt);
  }, []);

  const switchToTurnFallback = useCallback(() => {
    if (closingSessionRef.current) return;
    cleanupLiveAudioPipeline();
    isLiveReadyRef.current = false;
    transportModeRef.current = 'turn';
    setTransportMode('turn');
    setErrorMsg(null);
    setStatus('live');
  }, [cleanupLiveAudioPipeline]);

  const processVoiceTurnBlob = useCallback(
    async (blob: Blob, mimeType: string) => {
      if (closingSessionRef.current) return;
      setIsTurnProcessing(true);
      setErrorMsg(null);

      const controller = new AbortController();
      turnAbortRef.current = controller;

      try {
        const audioData = await blobToBase64(blob);
        const transcribeRes = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioData, mimeType }),
          signal: controller.signal,
        });
        const transcribeJson = (await transcribeRes.json()) as {
          transcript?: string;
          error?: string;
        };
        if (!transcribeRes.ok) {
          throw new Error(transcribeJson.error || 'Could not transcribe audio.');
        }

        const spokenText = (transcribeJson.transcript || '').trim();
        if (!spokenText) {
          setErrorMsg('No speech detected. Tap to speak and try again.');
          return;
        }

        const userTurn: VoiceTurn = {
          id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          text: spokenText,
        };
        const updatedHistory = [...turnsRef.current, userTurn];
        setTurns(updatedHistory);

        const chatRes = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: updatedHistory.slice(-12).map((t) => ({
              role: t.role,
              text: t.text,
            })),
            model: 'gemini-3.1-flash-lite',
            thinkingLevel: 'MINIMAL',
            adaptiveMode,
            userName: userName || undefined,
            systemInstruction:
              'Keep spoken replies natural, warm, clear, and concise (2 to 4 short sentences unless asked for more detail).',
          }),
          signal: controller.signal,
        });

        if (!chatRes.ok || !chatRes.body) {
          let errMsg = `Server returned status ${chatRes.status}`;
          try {
            const errJson = (await chatRes.json()) as { error?: string };
            if (errJson.error) errMsg = errJson.error;
          } catch {
            // ignore
          }
          throw new Error(errMsg);
        }

        const modelTurnId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const reader = chatRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let replyText = '';

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
            try {
              const evt = JSON.parse(rawEvent.slice(5).trim()) as {
                type?: string;
                text?: string;
                error?: string;
              };
              if (evt.type === 'chunk' && typeof evt.text === 'string') {
                replyText += evt.text;
                setModelTurnText(modelTurnId, replyText);
              } else if (evt.type === 'error') {
                throw new Error(evt.error || 'Voice reply failed.');
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
                throw parseErr;
              }
            }
          }
        }

        const cleanReply = replyText.replace(/—/g, '-').trim();
        if (!cleanReply) {
          throw new Error('Empty response received.');
        }

        const ttsRes = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleanReply, voice: voiceRef.current }),
          signal: controller.signal,
        });
        const ttsJson = (await ttsRes.json()) as { audioDataUrl?: string; error?: string };
        if (ttsRes.ok && ttsJson.audioDataUrl && !closingSessionRef.current) {
          const audio = new Audio(ttsJson.audioDataUrl);
          turnAudioRef.current = audio;
          setIsModelSpeaking(true);
          audio.onended = () => {
            if (turnAudioRef.current === audio) {
              turnAudioRef.current = null;
            }
            setIsModelSpeaking(false);
          };
          audio.onerror = () => {
            if (turnAudioRef.current === audio) {
              turnAudioRef.current = null;
            }
            setIsModelSpeaking(false);
          };
          await audio.play().catch(() => {
            setIsModelSpeaking(false);
          });
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError' && !closingSessionRef.current) {
          setErrorMsg(err instanceof Error ? err.message : 'Voice turn failed.');
        }
      } finally {
        if (turnAbortRef.current === controller) {
          turnAbortRef.current = null;
        }
        setIsTurnProcessing(false);
      }
    },
    [adaptiveMode, setModelTurnText, userName]
  );

  const toggleTurnRecording = useCallback(async () => {
    if (isTurnProcessing) return;

    if (isTurnRecording && turnRecorderRef.current) {
      if (turnRecorderRef.current.state !== 'inactive') {
        turnRecorderRef.current.stop();
      }
      setIsTurnRecording(false);
      return;
    }

    stopPlayback();
    setErrorMsg(null);

    try {
      let stream = streamRef.current;
      if (!stream || stream.getAudioTracks().every((t) => t.readyState !== 'live')) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;
      }

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

      turnChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          turnChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || supportedMime || 'audio/webm';
        const blob = new Blob(turnChunksRef.current, { type: mimeType });
        turnChunksRef.current = [];
        turnRecorderRef.current = null;
        if (!closingSessionRef.current && blob.size > 0) {
          void processVoiceTurnBlob(blob, mimeType);
        }
      };

      turnRecorderRef.current = recorder;
      recorder.start(200);
      setIsTurnRecording(true);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Microphone access is required for voice conversations.'
      );
    }
  }, [isTurnProcessing, isTurnRecording, processVoiceTurnBlob, stopPlayback]);

  const startSession = useCallback(async () => {
    cleanupResources();
    closingSessionRef.current = false;
    setErrorMsg(null);
    setTransportMode('live');
    transportModeRef.current = 'live';
    setStatus('connecting');
    setIsMuted(false);
    isMutedRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (closingSessionRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      if (inputCtx.state === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();
      inputCtxRef.current = inputCtx;
      outputCtxRef.current = outputCtx;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const userParam = userName ? `&userName=${encodeURIComponent(userName)}` : '';
      const wsUrl = `${protocol}//${window.location.host}/api/live?mode=${encodeURIComponent(
        adaptiveMode
      )}&voice=${encodeURIComponent(voiceRef.current)}${userParam}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const connectTimeout = window.setTimeout(() => {
        if (!isLiveReadyRef.current && !closingSessionRef.current && transportModeRef.current === 'live') {
          switchToTurnFallback();
        }
      }, 4500);

      ws.onopen = () => {
        const source = inputCtx.createMediaStreamSource(stream);
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        sourceNodeRef.current = source;
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (isMutedRef.current || !isLiveReadyRef.current) return;
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
          const base64 = float32ToPcmBase64(e.inputBuffer.getChannelData(0));
          wsRef.current.send(JSON.stringify({ type: 'audio', data: base64 }));
        };

        source.connect(processor);
        processor.connect(inputCtx.destination);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            data?: string;
            text?: string;
            error?: string;
          };
          if (msg.type === 'ready') {
            window.clearTimeout(connectTimeout);
            isLiveReadyRef.current = true;
            setStatus('live');
          } else if (msg.type === 'audio' && msg.data) {
            window.clearTimeout(connectTimeout);
            isLiveReadyRef.current = true;
            setStatus('live');
            scheduleAudioChunk(msg.data);
          } else if (msg.type === 'inputTranscript' && msg.text) {
            appendTurnChunk('user', msg.text);
          } else if (msg.type === 'outputTranscript' && msg.text) {
            appendTurnChunk('model', msg.text);
          } else if (msg.type === 'interrupted') {
            stopPlayback();
          } else if (msg.type === 'error') {
            window.clearTimeout(connectTimeout);
            if (!isLiveReadyRef.current) {
              switchToTurnFallback();
            } else {
              setErrorMsg(msg.error || 'Voice session failed.');
              setStatus('error');
            }
          } else if (msg.type === 'closed') {
            window.clearTimeout(connectTimeout);
            if (!isLiveReadyRef.current && !closingSessionRef.current) {
              switchToTurnFallback();
            } else {
              setStatus((prev) => (prev === 'error' ? prev : 'idle'));
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        window.clearTimeout(connectTimeout);
        if (!isLiveReadyRef.current && !closingSessionRef.current) {
          switchToTurnFallback();
        } else {
          setErrorMsg('Could not establish live voice connection.');
          setStatus('error');
        }
      };

      ws.onclose = () => {
        window.clearTimeout(connectTimeout);
        if (!isLiveReadyRef.current && !closingSessionRef.current) {
          switchToTurnFallback();
        } else if (transportModeRef.current === 'live') {
          setStatus((prev) => (prev === 'error' ? prev : 'idle'));
        }
      };
    } catch (err) {
      cleanupResources();
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Microphone access is required for voice conversations.'
      );
      setStatus('error');
    }
  }, [
    adaptiveMode,
    appendTurnChunk,
    cleanupResources,
    scheduleAudioChunk,
    stopPlayback,
    switchToTurnFallback,
    userName,
  ]);

  useEffect(() => {
    if (!isOpen) {
      cleanupResources();
      setStatus('idle');
      setErrorMsg(null);
      setTurns([]);
      return;
    }
    void startSession();
    return () => {
      cleanupResources();
    };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  const handleEndCall = () => {
    const captured = [...turnsRef.current];
    cleanupResources();
    if (captured.length > 0 && onSaveTranscript) {
      onSaveTranscript(captured);
    }
    onClose();
  };

  const statusLabel =
    status === 'connecting'
      ? 'Connecting voice session...'
      : status === 'error'
      ? 'Connection error'
      : transportMode === 'turn'
      ? isTurnRecording
        ? 'Listening... tap Stop when finished'
        : isTurnProcessing
        ? 'Thinking...'
        : isModelSpeaking
        ? 'Vesper is speaking'
        : 'Voice Turn Mode (Tap mic to talk)'
      : status === 'live'
      ? isModelSpeaking
        ? 'Vesper is speaking'
        : isMuted
        ? 'Mic muted'
        : 'Listening live'
      : 'Session ended';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090a0f]/80 p-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Voice Conversation"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-[#1e2333] dark:border-t-white/10 dark:bg-[#181b26]/95 dark:shadow-[0_0_40px_-8px_rgba(139,92,246,0.35)] dark:backdrop-blur-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-[#1e2333]">
          <div className="flex items-center gap-2.5">
            <Radio
              className={`h-4 w-4 ${
                status === 'live'
                  ? 'text-[#06b6d4] animate-pulse'
                  : 'text-slate-400 dark:text-[#94a3b8]'
              }`}
            />
            <div>
              <h2 className="font-display text-base font-semibold text-slate-950 dark:text-[#f8fafc]">
                Voice Conversation
              </h2>
              <p className="font-mono text-[11px] text-slate-500 dark:text-[#94a3b8]">
                {statusLabel}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleEndCall}
            aria-label="Close voice conversation"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-[#94a3b8] dark:hover:bg-[#292a2f] dark:hover:text-[#f8fafc]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex shrink-0 flex-col items-center border-b border-slate-200 px-5 py-5 dark:border-[#1e2333]">
          <div
            className={`relative flex h-24 w-24 items-center justify-center rounded-full border transition-all ${
              status === 'live'
                ? isModelSpeaking
                  ? 'border-[#06b6d4] bg-[#0f111a] shadow-[0_0_32px_rgba(6,182,212,0.4)]'
                  : isTurnRecording
                  ? 'border-red-500 bg-[#0f111a] shadow-[0_0_28px_rgba(239,68,68,0.4)]'
                  : 'border-[#8b5cf6]/70 bg-[#0f111a] shadow-[0_0_24px_rgba(139,92,246,0.3)]'
                : 'border-slate-200 bg-slate-100 dark:border-[#1e2333] dark:bg-[#0f111a]'
            }`}
          >
            {status === 'live' && (isModelSpeaking || isTurnRecording) && (
              <span
                aria-hidden="true"
                className={`absolute inset-0 rounded-full border animate-ping ${
                  isTurnRecording ? 'border-red-400/50' : 'border-[#06b6d4]/40'
                }`}
              />
            )}
            {isTurnProcessing ? (
              <Loader2 className="h-8 w-8 animate-spin text-[#4cd7f6]" />
            ) : (
              <Volume2
                className={`h-8 w-8 ${
                  status === 'live'
                    ? isModelSpeaking
                      ? 'text-[#4cd7f6]'
                      : isTurnRecording
                      ? 'text-red-400'
                      : 'text-[#d0bcff]'
                    : 'text-slate-400 dark:text-[#64748b]'
                }`}
              />
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {VOICES.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setVoice(v);
                  voiceRef.current = v;
                  if (transportModeRef.current === 'live' && (status === 'live' || status === 'connecting')) {
                    setTimeout(() => void startSession(), 0);
                  }
                }}
                className={`rounded-full px-3 py-1 font-mono text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  voice === v
                    ? 'bg-[#8b5cf6] text-white'
                    : 'border border-slate-200 bg-slate-50 text-slate-600 hover:text-slate-900 dark:border-[#1e2333] dark:bg-[#0f111a] dark:text-[#94a3b8] dark:hover:text-[#f8fafc]'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          {errorMsg && (
            <div className="mt-4 flex w-full items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 dark:border-[#93000a] dark:bg-[#93000a]/30 dark:text-[#ffb4ab]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">{errorMsg}</div>
              <button
                type="button"
                onClick={() => void startSession()}
                className="font-medium underline"
              >
                Retry
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {turns.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500 dark:text-[#64748b]">
              {transportMode === 'turn'
                ? 'Tap "Speak" below, ask anything naturally, then tap "Stop & Send" to hear Vesper reply.'
                : 'Start speaking naturally. Live transcripts will appear here.'}
            </p>
          ) : (
            turns.map((turn) => (
              <div
                key={turn.id}
                className={`flex flex-col ${
                  turn.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <span className="mb-1 font-mono text-[10px] text-slate-400 dark:text-[#64748b]">
                  {turn.role === 'user' ? userName || 'You' : 'Vesper'}
                </span>
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                    turn.role === 'user'
                      ? 'bg-violet-600 text-white dark:border dark:border-[#8b5cf6]/30 dark:bg-[#0f111a] dark:text-[#e3e1e9]'
                      : 'border border-slate-200 bg-slate-50 text-slate-800 dark:border-[#1e2333] dark:bg-[#090a0f]/70 dark:text-[#cbd3e1]'
                  }`}
                >
                  {turn.text}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 px-5 py-3.5 dark:border-[#1e2333]">
          {transportMode === 'turn' ? (
            <button
              type="button"
              onClick={() => void toggleTurnRecording()}
              disabled={status !== 'live' || isTurnProcessing}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-colors disabled:opacity-40 whitespace-nowrap shrink-0 ${
                isTurnRecording
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'border-t border-white/25 bg-gradient-to-r from-[#8b5cf6] to-[#7c3aed] text-white shadow-[0_0_16px_rgba(139,92,246,0.35)] hover:opacity-95'
              }`}
            >
              {isTurnRecording ? (
                <>
                  <Square className="h-3 w-3 fill-current" />
                  <span>Stop &amp; Send</span>
                </>
              ) : isTurnProcessing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Replying...</span>
                </>
              ) : (
                <>
                  <Mic className="h-3.5 w-3.5" />
                  <span>Tap to Speak</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIsMuted((prev) => !prev)}
              disabled={status !== 'live'}
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium transition-colors disabled:opacity-40 whitespace-nowrap shrink-0 ${
                isMuted
                  ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-[#ca801e]/60 dark:bg-[#ca801e]/20 dark:text-[#ffb869]'
                  : 'border-slate-200 bg-slate-100 text-slate-800 hover:bg-slate-200 dark:border-[#1e2333] dark:bg-[#0f111a] dark:text-[#e3e1e9] dark:hover:bg-[#1e2333]'
              }`}
            >
              {isMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
              <span>{isMuted ? 'Unmute' : 'Mute mic'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleEndCall}
            className="inline-flex items-center gap-2 rounded-full bg-red-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-red-700 whitespace-nowrap shrink-0"
          >
            <PhoneOff className="h-3.5 w-3.5" />
            <span>{turns.length > 0 ? 'End & Save to Chat' : 'End Call'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
