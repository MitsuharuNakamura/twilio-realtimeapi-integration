const express = require('express');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Twilio Webhookエンドポイント
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  console.log(`Incoming call: ${callSid}`);
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Say language="ja-JP">日本語を英語に翻訳します</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="callSid" value="${callSid}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// HTTPサーバーの作成
const server = app.listen(PORT, () => {
  console.log(`OpenAI Realtime server is running on port ${PORT}`);
});

// WebSocketサーバーの作成
const wss = new WebSocket.Server({ 
  server, 
  path: '/media-stream'
});

// WebSocket接続の管理
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let isResponseActive = false;
  let speechStartTime = null;
  let speechEndTime = null;
  let responseStartTime = null;
  
  // OpenAI Realtime APIに接続（日本語→英語リアルタイム翻訳）
  function connectToOpenAI() {
    // OpenAIのモデルを設定
    const url = `wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_MODEL}`;
    
    openaiWs = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    openaiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      
      // セッションの設定
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `${process.env.OPENAI_SYSYEM_PROMPT}`,
          voice: 'alloy',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.2,
            prefix_padding_ms: 300,
            silence_duration_ms: 800
          }
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
    });
    
    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        
        switch (event.type) {
          // セッション作成完了イベント
          case 'session.created':
            console.log('OpenAI session created');
            break;
            
          // セッション設定更新完了イベント
          case 'session.updated':
            console.log('OpenAI session updated');
            break;
            
          // AI応答の生成開始イベント
          case 'response.created':
            console.log(`[${new Date().toISOString()}] Response created`);
            isResponseActive = true;
            break;
            
          // 会話アイテム作成イベント（ユーザーまたはアシスタントのメッセージ）
          case 'conversation.item.created':
            if (event.item && event.item.role === 'assistant') {
              console.log('Assistant message created');
            }
            break;
            
          // 音声レスポンスのストリーミングデータ受信イベント
          case 'response.audio.delta':
            // 音声データを受信（g711_ulaw形式）
            if (event.delta) {
              // 最初の音声データが来た時点でレスポンス開始時間を記録
              if (!responseStartTime) {
                responseStartTime = Date.now();
                const totalProcessingTime = speechEndTime ? responseStartTime - speechEndTime : 0;
                console.log(`[${new Date().toISOString()}] English response started`);
                console.log(`RESPONSE LATENCY (Japanese speech end → English speech start): ${totalProcessingTime}ms`);
              }
              // 直接Twilioに送信（変換不要！）
              sendAudioToTwilio(event.delta);
            }
            break;
            
          // 音声レスポンスの文字起こし中間結果イベント
          case 'response.audio_transcript.delta':
            // 文字起こしの差分を受信
            process.stdout.write(event.delta);
            break;
            
          // 音声レスポンスの文字起こし完了イベント
          case 'response.audio_transcript.done':
            // 文字起こし完了
            console.log('\nTranscript completed:', event.transcript);
            break;
            
          // ユーザーの音声入力開始検出イベント
          case 'input_audio_buffer.speech_started':
            speechStartTime = Date.now();
            console.log(`[${new Date().toISOString()}] Speech detected (AI active: ${isResponseActive})`);
            // AIが話している最中にユーザーが話し始めたら応答を中断
            if (isResponseActive && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
              console.log('Interrupting AI response...');
              openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
              isResponseActive = false;
            }
            break;
            
          // ユーザーの音声入力終了検出イベント
          case 'input_audio_buffer.speech_stopped':
            speechEndTime = Date.now();
            const speechDuration = speechStartTime ? speechEndTime - speechStartTime : 0;
            console.log(`[${new Date().toISOString()}] Japanese speech ended (duration: ${speechDuration}ms)`);
            break;
            
          // ユーザー音声の文字起こし完了イベント
          case 'conversation.item.input_audio_transcription.completed':
            const transcriptionTime = Date.now();
            const speechToTranscriptTime = speechEndTime ? transcriptionTime - speechEndTime : 0;
            console.log(`[${new Date().toISOString()}] User said: "${event.transcript}"`);
            console.log(`Speech-to-text processing time: ${speechToTranscriptTime}ms`);
            break;
            
          // ユーザーメッセージ作成イベント（デバッグ用）
          case 'conversation.item.created':
            if (event.item && event.item.type === 'message' && event.item.role === 'user') {
              console.log('User message created:', event.item);
            }
            break;
            
          // AI応答完了イベント
          case 'response.done':
            const responseEndTime = Date.now();
            const responseGenerationTime = responseStartTime ? responseEndTime - responseStartTime : 0;
            const totalTime = speechStartTime ? responseEndTime - speechStartTime : 0;
            console.log(`[${new Date().toISOString()}] English response completed`);
            console.log(`English response generation time: ${responseGenerationTime}ms`);
            console.log(`TOTAL TIME (Japanese speech start → English response end): ${totalTime}ms`);
            console.log('---------------------------------------------------');
            isResponseActive = false;
            responseStartTime = null;
            break;
            
          // AI応答キャンセルイベント（ユーザー割り込み時）
          case 'response.cancelled':
            console.log('Response cancelled');
            isResponseActive = false;
            responseStartTime = null;
            break;
            
          // エラーイベント
          case 'error':
            console.error('OpenAI error:', event.error);
            break;
        }
      } catch (error) {
        console.error('Error parsing OpenAI message:', error);
      }
    });
    
    openaiWs.on('error', (error) => {
      console.error('OpenAI WebSocket error:', error);
    });
    
    openaiWs.on('close', () => {
      console.log('Disconnected from OpenAI');
    });
  }
  
  // Twilioメッセージの処理
  ws.on('message', async (message) => {
    const data = JSON.parse(message);

    switch (data.event) {
      // Twilio WebSocket接続確立イベント
      case 'connected':
        console.log('Twilio connected');
        break;

      // 音声ストリーム開始イベント
      case 'start':
        streamSid = data.streamSid;
        callSid = data.start.callSid;
        console.log(`Stream started: ${streamSid}`);
        
        // OpenAIに接続
        connectToOpenAI();
        break;

      // 音声データ受信イベント（20msごと）
      case 'media':
        // Twilioからの音声データ（μ-law）を受信
        if (data.media.payload && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          // OpenAIに直接μ-lawデータを送信（変換不要！）
          const audioMessage = {
            type: 'input_audio_buffer.append',
            audio: data.media.payload // そのままbase64データを使用
          };
          
          openaiWs.send(JSON.stringify(audioMessage));
        }
        break;

      // 音声ストリーム終了イベント
      case 'stop':
        console.log('Stream stopped');
        if (openaiWs) {
          openaiWs.close();
        }
        break;
    }
  });
  
  // μ-law音声をTwilioに送信
  function sendAudioToTwilio(base64AudioData) {
    if (ws.readyState !== WebSocket.OPEN || !streamSid || !base64AudioData) {
      return;
    }
    
    // Base64データをバイナリに変換
    const audioBuffer = Buffer.from(base64AudioData, 'base64');
    
    // 160バイト（20ms）のチャンクに分割
    const chunkSize = 160;
    
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
      const chunk = audioBuffer.subarray(i, Math.min(i + chunkSize, audioBuffer.length));
      
      const mediaMessage = {
        event: 'media',
        streamSid: streamSid,
        media: {
          payload: chunk.toString('base64')
        }
      };
      
      ws.send(JSON.stringify(mediaMessage));
    }
  }
  
  ws.on('close', () => {
    console.log('Client disconnected');
    if (openaiWs) {
      openaiWs.close();
    }
  });
});