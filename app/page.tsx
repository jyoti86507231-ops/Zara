'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2, Sparkles, AlertCircle, RefreshCw, Radio, Server, ShieldCheck, Heart, User } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Downsample audio helper
function downsampleBuffer(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number = 16000) {
  if (inputSampleRate === outputSampleRate) {
    return buffer;
  }
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

// Float32 to Int16 helper
function float32ToInt16(buffer: Float32Array): Int16Array {
  const result = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    result[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return result;
}

// Convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer: ArrayBuffer | SharedArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert Base64 to Float32 PCM
function base64ToFloat32PCM(base64: string): Float32Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

interface Message {
  sender: 'user' | 'zara';
  text: string;
  interrupted?: boolean;
}

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'speaking' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Message[]>([]);
  const [micVolume, setMicVolume] = useState<number>(0);
  const [zaraVolume, setZaraVolume] = useState<number>(0);

  // Connection refs
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  
  // Playback scheduler refs
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  
  // Animation/Visualizer refs
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  // Scrolling transcription box
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const cleanup = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    
    if (microphoneStreamRef.current) {
      microphoneStreamRef.current.getTracks().forEach(track => track.stop());
      microphoneStreamRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    // Stop playback of any active sources
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {}
    });
    activeSourcesRef.current = [];

    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }

    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
    setStatus('idle');
    setMicVolume(0);
    setZaraVolume(0);
  };

  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  // Set up animation loop for real-time visualization
  useEffect(() => {
    if (!isConnected) {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
      return;
    }

    const updateWaves = () => {
      // Calculate microphone input volume
      if (micAnalyserRef.current && !isMuted) {
        const dataArray = new Uint8Array(micAnalyserRef.current.frequencyBinCount);
        micAnalyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        setMicVolume(average / 128); // normalize roughly
      } else {
        setMicVolume(0);
      }

      // Calculate Zara's output volume
      if (outputAnalyserRef.current) {
        const dataArray = new Uint8Array(outputAnalyserRef.current.frequencyBinCount);
        outputAnalyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        setZaraVolume(average / 128); // normalize roughly
      } else {
        setZaraVolume(0);
      }

      // Update status dynamically based on who is producing more volume
      if (isConnected) {
        if (zaraVolume > 0.05) {
          setStatus('speaking');
        } else if (micVolume > 0.05 && !isMuted) {
          setStatus('listening');
        } else {
          // If silent but connected
          setStatus('listening');
        }
      }

      animationFrameIdRef.current = requestAnimationFrame(updateWaves);
    };

    animationFrameIdRef.current = requestAnimationFrame(updateWaves);

    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [isConnected, isMuted, micVolume, zaraVolume]);

  const startConnection = async () => {
    if (isConnecting || isConnected) return;

    setIsConnecting(true);
    setErrorMessage(null);
    setStatus('connecting');

    try {
      // 1. Request Microphone Access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      microphoneStreamRef.current = stream;

      // 2. Establish WebSocket connection to backend custom server
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/live`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WebSocket] Connection established');
        setIsConnected(true);
        setIsConnecting(false);
        setStatus('listening');
        setTranscripts([{ sender: 'zara', text: 'Hello! I am Zara. How can I help you today?' }]);
        
        // Initialize Web Audio API contexts only after WebSocket opens
        initAudio(stream);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        // Handle raw audio chunk from Zara
        if (msg.audio) {
          playAudioChunk(msg.audio);
        }

        // Handle interruption (barge-in)
        if (msg.interrupted) {
          handleInterruption();
        }

        // Handle text transcription updates
        if (msg.text) {
          appendTranscript('zara', msg.text);
        }

        // Handle user speech transcription updates
        if (msg.userText) {
          appendTranscript('user', msg.userText);
        }

        // Handle standard socket error
        if (msg.error) {
          setErrorMessage(msg.error);
          cleanup();
        }
      };

      ws.onerror = (e) => {
        console.error('[WebSocket] Error:', e);
        setErrorMessage('Failed to connect to the Zara voice socket.');
        cleanup();
      };

      ws.onclose = () => {
        console.log('[WebSocket] Closed');
        cleanup();
      };

    } catch (err: any) {
      console.error('[Audio/WS] Permission/Connection failed:', err);
      setErrorMessage(
        err.name === 'NotAllowedError' 
          ? 'Microphone permission denied. Please allow mic access and try again.' 
          : 'Failed to access microphone or connect to voice server.'
      );
      cleanup();
    }
  };

  const initAudio = (stream: MediaStream) => {
    // 1. Create Input AudioContext (runs at system default sample rate, e.g. 48kHz)
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const inputAudioCtx = new AudioContextClass();
    audioContextRef.current = inputAudioCtx;

    // Create dynamic analyser for mic visualization
    const micAnalyser = inputAudioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    micAnalyserRef.current = micAnalyser;

    const source = inputAudioCtx.createMediaStreamSource(stream);
    source.connect(micAnalyser);

    // Create downsampling processor
    const processor = inputAudioCtx.createScriptProcessor(2048, 1, 1);
    micAnalyser.connect(processor);
    processor.connect(inputAudioCtx.destination);
    scriptProcessorRef.current = processor;

    const inputSampleRate = inputAudioCtx.sampleRate;

    // Process mic buffer chunks and send as 16kHz PCM
    processor.onaudioprocess = (e) => {
      if (isMuted) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(inputData, inputSampleRate, 16000);
      const int16Data = float32ToInt16(downsampled);
      const base64Audio = arrayBufferToBase64(int16Data.buffer);

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ audio: base64Audio }));
      }
    };

    // 2. Create Output AudioContext (runs strictly at 24kHz for Gemini Live API audio native output)
    const outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
    outputAudioCtxRef.current = outputAudioCtx;

    // Create dynamic analyser for Zara's voice visualization
    const outputAnalyser = outputAudioCtx.createAnalyser();
    outputAnalyser.fftSize = 256;
    outputAnalyserRef.current = outputAnalyser;
    outputAnalyser.connect(outputAudioCtx.destination);

    nextStartTimeRef.current = outputAudioCtx.currentTime;
  };

  const playAudioChunk = (base64Audio: string) => {
    if (!outputAudioCtxRef.current || !outputAnalyserRef.current) return;

    if (outputAudioCtxRef.current.state === 'suspended') {
      outputAudioCtxRef.current.resume();
    }

    const pcmData = base64ToFloat32PCM(base64Audio);
    if (pcmData.length === 0) return;

    const audioBuffer = outputAudioCtxRef.current.createBuffer(1, pcmData.length, 24000);
    audioBuffer.getChannelData(0).set(pcmData);

    const sourceNode = outputAudioCtxRef.current.createBufferSource();
    sourceNode.buffer = audioBuffer;
    
    // Connect source to analyser first, which is connected to destination
    sourceNode.connect(outputAnalyserRef.current);

    const currentTime = outputAudioCtxRef.current.currentTime;
    let startTime = nextStartTimeRef.current;

    // If we fell behind, sync forward with a minimal buffer
    if (startTime < currentTime) {
      startTime = currentTime + 0.05;
    }

    sourceNode.start(startTime);
    nextStartTimeRef.current = startTime + audioBuffer.duration;

    // Track active sources so we can stop playback immediately on barge-in
    activeSourcesRef.current.push(sourceNode);
    sourceNode.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(node => node !== sourceNode);
    };
  };

  const handleInterruption = () => {
    console.log('[Interruption] User started speaking, stopping Zara');
    
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {}
    });
    activeSourcesRef.current = [];

    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime + 0.05;
    }

    setStatus('listening');

    // Mark last Zara message as interrupted
    setTranscripts(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.sender === 'zara') {
        return [
          ...prev.slice(0, -1),
          { ...last, interrupted: true }
        ];
      }
      return prev;
    });
  };

  const appendTranscript = (sender: 'user' | 'zara', text: string) => {
    setTranscripts(prev => {
      if (prev.length === 0) {
        return [{ sender, text }];
      }

      const last = prev[prev.length - 1];
      if (last.sender === sender && !last.interrupted) {
        // If the last message was from the same sender, append text to keep it conversational and cohesive
        return [
          ...prev.slice(0, -1),
          { sender, text: last.text + ' ' + text }
        ];
      } else {
        // Create a new bubble
        return [...prev, { sender, text }];
      }
    });
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const stopConnection = () => {
    cleanup();
  };

  // Helper to format visual orb pulse
  const getOrbScale = () => {
    if (status === 'connecting') return 1.1;
    if (status === 'speaking') return 1 + zaraVolume * 0.4;
    if (status === 'listening') return 1 + micVolume * 0.3;
    return 1;
  };

  const getOrbColor = () => {
    if (status === 'connecting') return 'from-amber-500 to-orange-600 shadow-amber-500/50';
    if (status === 'speaking') return 'from-violet-500 to-indigo-600 shadow-violet-500/50';
    if (status === 'listening') return 'from-emerald-500 to-teal-600 shadow-emerald-500/50';
    if (status === 'error') return 'from-rose-500 to-red-600 shadow-rose-500/50';
    return 'from-zinc-700 to-zinc-800 shadow-zinc-700/30';
  };

  return (
    <div id="zara-app-root" className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans antialiased selection:bg-zinc-800 selection:text-white">
      {/* Background radial glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(63,63,70,0.15),transparent_60%)] pointer-events-none" />

      {/* Header */}
      <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-gradient-to-tr from-violet-600 to-indigo-600 p-2 rounded-xl shadow-lg shadow-indigo-600/20">
            <Radio className="w-5 h-5 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white flex items-center gap-2">
              Zara <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400">Live Voice</span>
            </h1>
            <p className="text-xs text-zinc-400">Interactive Conversational Voice AI</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <div className="hidden sm:flex items-center space-x-1.5 text-xs text-zinc-400 bg-zinc-900 px-3 py-1.5 rounded-full border border-zinc-800">
            <Server className="w-3.5 h-3.5 text-zinc-500" />
            <span>Developer:</span>
            <span className="font-medium text-white">Ayush Rajput</span>
          </div>
        </div>
      </header>

      {/* Main Panel */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 flex flex-col md:flex-row gap-6 relative z-10 overflow-hidden">
        
        {/* Left Side: Voice Visualization Orb */}
        <div className="flex-1 flex flex-col items-center justify-center bg-zinc-900/40 rounded-3xl border border-zinc-900 p-6 sm:p-8 backdrop-blur-sm shadow-xl min-h-[380px] sm:min-h-[440px]">
          <div className="w-full text-center mb-6">
            <span className="text-xs font-mono uppercase tracking-widest text-zinc-500 flex items-center justify-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
              {status === 'idle' && 'SYSTEM READY'}
              {status === 'connecting' && 'CONNECTING TO VOICE GATEWAY'}
              {status === 'listening' && 'ZARA IS LISTENING'}
              {status === 'speaking' && 'ZARA IS SPEAKING'}
              {status === 'error' && 'CONNECTION ERROR'}
            </span>
          </div>

          {/* Glowing Voice Orb */}
          <div className="relative flex-1 flex items-center justify-center py-6">
            {/* Pulsing Outer Ring */}
            <AnimatePresence>
              {isConnected && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ 
                    opacity: [0.15, 0.4, 0.15],
                    scale: getOrbScale() * 1.5,
                  }}
                  exit={{ opacity: 0 }}
                  transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
                  className={`absolute w-44 h-44 rounded-full bg-gradient-to-tr ${getOrbColor()} blur-xl pointer-events-none`}
                />
              )}
            </AnimatePresence>

            {/* Glowing Medium Ring */}
            <AnimatePresence>
              {isConnected && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ 
                    opacity: [0.25, 0.6, 0.25],
                    scale: getOrbScale() * 1.25,
                  }}
                  exit={{ opacity: 0 }}
                  transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
                  className={`absolute w-36 h-36 rounded-full bg-gradient-to-tr ${getOrbColor()} blur-md pointer-events-none`}
                />
              )}
            </AnimatePresence>

            {/* Core Orb Button */}
            <motion.button
              whileHover={{ scale: isConnected ? 1.02 : 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={isConnected ? stopConnection : startConnection}
              disabled={isConnecting}
              style={{ scale: getOrbScale() }}
              className={`relative w-28 h-28 sm:w-32 sm:h-32 rounded-full bg-gradient-to-tr ${getOrbColor()} shadow-2xl flex flex-col items-center justify-center text-white cursor-pointer select-none transition-all duration-300 z-10 border border-white/10`}
            >
              {isConnecting ? (
                <RefreshCw className="w-8 h-8 animate-spin" />
              ) : isConnected ? (
                <motion.div className="flex flex-col items-center">
                  <span className="w-3.5 h-3.5 bg-white rounded-md mb-1.5" />
                  <span className="text-[10px] font-semibold tracking-wider uppercase opacity-80">Stop</span>
                </motion.div>
              ) : (
                <motion.div className="flex flex-col items-center">
                  <Mic className="w-9 h-9 text-white mb-1 animate-pulse" />
                  <span className="text-[10px] font-semibold tracking-wider uppercase opacity-90">Talk</span>
                </motion.div>
              )}
            </motion.button>
          </div>

          {/* Action Description */}
          <div className="w-full text-center mt-6">
            <h3 className="text-base font-medium text-white mb-1">
              {status === 'idle' && 'Begin Conversation'}
              {status === 'connecting' && 'Opening Socket Connection'}
              {status === 'listening' && 'Start speaking now...'}
              {status === 'speaking' && 'Zara is responding...'}
              {status === 'error' && 'Something went wrong'}
            </h3>
            <p className="text-xs text-zinc-400 max-w-xs mx-auto">
              {status === 'idle' && 'Click the microphone button to start a real-time vocal session with Zara.'}
              {status === 'connecting' && 'Connecting to Zara voice gateway. Please accept any microphone permissions.'}
              {status === 'listening' && 'Zara is listening. Just speak naturally. Barge-in is enabled—interrupt any time!'}
              {status === 'speaking' && 'Listen to Zara’s output or interrupt her by speaking at any point.'}
              {status === 'error' && (errorMessage || 'Connection failed. Please check your network and try again.')}
            </p>
          </div>

          {/* In-Call Controls */}
          {isConnected && (
            <div className="flex items-center space-x-3 mt-6 pt-5 border-t border-zinc-900 w-full justify-center">
              <button
                onClick={toggleMute}
                className={`p-3 rounded-full border transition-all duration-200 flex items-center justify-center ${
                  isMuted 
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-500 hover:bg-rose-500/20' 
                    : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-white'
                }`}
                title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
              
              <button
                onClick={stopConnection}
                className="px-5 py-2.5 rounded-full bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-zinc-200 hover:text-white text-xs font-semibold tracking-wide transition-all duration-200"
              >
                Disconnect
              </button>
            </div>
          )}
        </div>

        {/* Right Side: Dialogue Transcripts */}
        <div className="flex-1 flex flex-col bg-zinc-900/40 rounded-3xl border border-zinc-900 backdrop-blur-sm shadow-xl min-h-[380px] sm:min-h-[440px] overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-900 bg-zinc-900/20 flex items-center justify-between">
            <span className="text-xs font-mono tracking-wider uppercase text-zinc-400 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              Live Transcript
            </span>
            <span className="text-[10px] font-mono text-zinc-500 bg-zinc-900 px-2 py-0.5 border border-zinc-800 rounded">
              {transcripts.length} Messages
            </span>
          </div>

          {/* Scrollable Conversation Bubbles */}
          <div className="flex-1 p-5 overflow-y-auto space-y-4 max-h-[360px] custom-scrollbar scroll-smooth">
            {transcripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center opacity-40 py-12 px-4">
                <Sparkles className="w-8 h-8 text-zinc-500 mb-2 animate-bounce" />
                <h4 className="text-sm font-medium text-zinc-300">No Dialogue Yet</h4>
                <p className="text-xs text-zinc-500 mt-1 max-w-[240px]">
                  Start a connection and begin speaking. Transcripts of Zara&apos;s remarks will display here.
                </p>
              </div>
            ) : (
              transcripts.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex flex-col ${
                    msg.sender === 'user' ? 'items-end' : 'items-start'
                  }`}
                >
                  <div className="flex items-center space-x-1.5 mb-1 text-[10px] font-mono text-zinc-500 uppercase px-1">
                    {msg.sender === 'user' ? (
                      <>
                        <span>You</span>
                        <User className="w-3 h-3 text-zinc-500" />
                      </>
                    ) : (
                      <>
                        <div className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-ping" />
                        <span className="text-violet-400 font-medium">Zara</span>
                      </>
                    )}
                  </div>

                  <div
                    className={`px-4 py-3 rounded-2xl text-sm leading-relaxed max-w-[85%] border relative shadow-md ${
                      msg.sender === 'user'
                        ? 'bg-zinc-800 border-zinc-700 text-zinc-100 rounded-tr-none'
                        : 'bg-zinc-900 border-violet-950/40 text-violet-50 rounded-tl-none'
                    }`}
                  >
                    <p>{msg.text}</p>
                    {msg.interrupted && (
                      <span className="block text-[9px] font-mono text-amber-500 mt-1 uppercase tracking-wider font-semibold">
                        [ Interrupted / Barge-in ]
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>

          {/* App Specifications Info Card */}
          <div className="bg-zinc-950/60 p-4 border-t border-zinc-900 text-[11px] text-zinc-500 leading-relaxed font-mono space-y-1.5">
            <div className="flex items-center justify-between">
              <span>Voice Model:</span>
              <span className="text-zinc-300">gemini-2.5-flash-preview-12-2025</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Input Stream:</span>
              <span className="text-zinc-300">16kHz Int16 Mono PCM</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Output Stream:</span>
              <span className="text-zinc-300">24kHz Int16 Mono PCM</span>
            </div>
          </div>
        </div>
      </main>

      {/* Info Badge */}
      <footer className="py-4 px-6 border-t border-zinc-900 text-center text-xs text-zinc-500 mt-auto bg-zinc-950/40">
        <p className="flex items-center justify-center gap-1">
          <span>Voice AI Assistant Zara</span>
          <span className="text-zinc-700">•</span>
          <span>Ayush Rajput</span>
          <span className="text-zinc-700">•</span>
          <span>Google AI Studio Build</span>
        </p>
      </footer>
    </div>
  );
}
