import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
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

export function VoiceSessionModal({
  isOpen,
  adaptiveMode,
  onClose,
  onSaveTranscript,
}: VoiceSessionModalProps) {
  const [voice, setVoice] = useState<(typeof VOICES)[number]>('Zephyr');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
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
  const turnsRef = useRef<VoiceTurn[]>([]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

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
    setIsModelSpeaking(false);
  }, []);

  const cleanupResources = useCallback(() => {
    isLiveReadyRef.current = false;
    stopPlayback();

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

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
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
  }, [stopPlayback]);

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

  const startSession = useCallback(async () => {
    cleanupResources();
    setErrorMsg(null);
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
      streamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      if (inputCtx.state === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();
      inputCtxRef.current = inputCtx;
      outputCtxRef.current = outputCtx;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/live?mode=${encodeURIComponent(
        adaptiveMode
      )}&voice=${encodeURIComponent(voice)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

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
            isLiveReadyRef.current = true;
            setStatus('live');
          } else if (msg.type === 'audio' && msg.data) {
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
            setErrorMsg(msg.error || 'Voice session failed.');
            setStatus('error');
          } else if (msg.type === 'closed') {
            setStatus((prev) => (prev === 'error' ? prev : 'idle'));
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        setErrorMsg('Could not establish live voice connection.');
        setStatus('error');
      };

      ws.onclose = () => {
        setStatus((prev) => (prev === 'error' ? prev : 'idle'));
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
  }, [adaptiveMode, appendTurnChunk, cleanupResources, scheduleAudioChunk, stopPlayback, voice]);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090a0f]/80 p-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Live Voice Conversation"
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
                {status === 'connecting'
                  ? 'Connecting to gemini-3.8-live...'
                  : status === 'live'
                  ? isModelSpeaking
                    ? 'Vesper is speaking'
                    : isMuted
                    ? 'Mic muted'
                    : 'Listening live'
                  : status === 'error'
                  ? 'Connection error'
                  : 'Session ended'}
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
                  : 'border-[#8b5cf6]/70 bg-[#0f111a] shadow-[0_0_24px_rgba(139,92,246,0.3)]'
                : 'border-slate-200 bg-slate-100 dark:border-[#1e2333] dark:bg-[#0f111a]'
            }`}
          >
            {status === 'live' && (
              <span
                aria-hidden="true"
                className={`absolute inset-0 rounded-full border ${
                  isModelSpeaking
                    ? 'animate-ping border-[#06b6d4]/40'
                    : 'border-[#8b5cf6]/25'
                }`}
              />
            )}
            <Volume2
              className={`h-8 w-8 ${
                status === 'live'
                  ? isModelSpeaking
                    ? 'text-[#4cd7f6]'
                    : 'text-[#d0bcff]'
                  : 'text-slate-400 dark:text-[#64748b]'
              }`}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {VOICES.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setVoice(v);
                  if (status === 'live' || status === 'connecting') {
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
              Start speaking naturally. Live transcripts will appear here.
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
                  {turn.role === 'user' ? 'Kyle' : 'Vesper'}
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
