import express from 'express';
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { searchTavily } from './lib/tavily.js';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn('[Warning] GEMINI_API_KEY is not defined in environment variables.');
}

const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

app.prepare().then(() => {
  const expressApp = express();
  const httpServer = createServer(expressApp);
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade to WebSockets on /api/live
  httpServer.on('upgrade', (request, socket, head) => {
    const parsedUrl = parse(request.url || '', true);
    const { pathname } = parsedUrl;

    if (pathname === '/api/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (clientWs) => {
    console.log('[WebSocket] Client voice session connected');
    let session: any = null;

    try {
      // Connect to Gemini Live API with the requested gemini-3.1-flash-live-preview model
      session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                // Prebuilt voice options: 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
                voiceName: 'Kore'
              }
            }
          },
          systemInstruction: "Your name is Zara. You are a real-time voice AI assistant created by Ayush Rajput. If asked who created you or who your developer is, you must answer 'Ayush Rajput'. You have the ability to search the web in real-time to answer questions about politics, countries, news, politicians, and current affairs. Keep your responses short, conversational, helpful, and friendly. Do not use markdown, emojis, asterisks, or complex symbols since your responses will be spoken aloud to the user. When searching, quickly and naturally synthesize the facts without mentioning URLs.",
          tools: [
            {
              functionDeclarations: [
                {
                  name: "search_web",
                  description: "Search the web for real-time information, news, current events, politics, politicians, countries, and factual knowledge.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The search query to look up on the web."
                      }
                    },
                    required: ["query"]
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: (message: any) => {
            // Handle barge-in/interruption
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }

            // Capture and forward raw modelTurn parts (both text and inline audio)
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
                }
                if (part.text) {
                  clientWs.send(JSON.stringify({ text: part.text }));
                }
              }
            }

            // Capture and forward userTurn text transcription if available
            const userParts = message.serverContent?.userTurn?.parts;
            if (userParts) {
              for (const part of userParts) {
                if (part.text) {
                  clientWs.send(JSON.stringify({ userText: part.text }));
                }
              }
            }

            // Handle tool call (function call) from model
            const toolCall = message.toolCall;
            if (toolCall?.functionCalls) {
              for (const call of toolCall.functionCalls) {
                if (call.name === 'search_web') {
                  const query = call.args?.query as string;
                  console.log(`[Gemini Live] Model requested search_web for query: "${query}"`);
                  
                  // Let the client know Zara is searching/thinking
                  clientWs.send(JSON.stringify({ text: `[Searching web for: "${query}"]...` }));
                  
                  searchTavily(query).then((searchResult) => {
                    const resultsText = searchResult.results && searchResult.results.length > 0
                      ? searchResult.results.map((r: any) => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`).join('\n\n')
                      : "No results found.";
                    
                    console.log(`[Gemini Live] Sending search results to model (length: ${resultsText.length})`);
                    
                    session.sendToolResponse({
                      functionResponses: [{
                        name: 'search_web',
                        id: call.id,
                        response: { output: { results: resultsText } }
                      }]
                    });
                  }).catch((err) => {
                    console.error("[Gemini Live] Search error:", err);
                    session.sendToolResponse({
                      functionResponses: [{
                        name: 'search_web',
                        id: call.id,
                        response: { error: err.message || String(err) }
                      }]
                    });
                  });
                }
              }
            }
          }
        }
      });

      console.log('[Gemini Live] Session established successfully');
    } catch (err) {
      console.error('[Gemini Live] Connection upgrade error:', err);
      clientWs.send(JSON.stringify({ error: 'Failed to initialize Zara voice model. Please verify your GEMINI_API_KEY.' }));
      clientWs.close();
      return;
    }

    // Capture incoming 16kHz audio from client and pipe into Gemini session using sendRealtimeInput
    clientWs.on('message', (messageData) => {
      try {
        const parsed = JSON.parse(messageData.toString());
        if (parsed.audio && session) {
          session.sendRealtimeInput({
            audio: {
              data: parsed.audio,
              mimeType: 'audio/pcm;rate=16000'
            }
          });
        }
      } catch (err) {
        console.error('[WebSocket] Error processing audio input chunk:', err);
      }
    });

    clientWs.on('close', () => {
      console.log('[WebSocket] Client disconnected');
      if (session) {
        try {
          session.close();
        } catch (e) {
          // already closed
        }
      }
    });
  });

  // Let Next.js handle all general HTTP and API routing requests
  expressApp.all(/.*/, (req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const port = 3000; // MUST be port 3000 in accordance with runtime guidelines
  httpServer.listen(port, () => {
    console.log(`> Custom WebSocket Voice server ready on http://localhost:${port}`);
  });
});
