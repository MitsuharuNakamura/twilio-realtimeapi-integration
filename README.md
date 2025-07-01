# Twilio - OpenAI Realtime API Integration

TwilioとOpenAI Realtime APIを組み合わせた日本語を英語に翻訳するAgent機能

## 機能

- Twilioの電話着信をWebSocket経由で受信
- リアルタイムで音声をOpenAI Whisperに送信して文字起こし
- GPT-4で応答を生成
- Text-to-Speechで音声応答を生成

## セットアップ

1. 依存関係のインストール
```bash
npm install
```

2. 環境変数の設定
```bash
cp .env.example .env
```
`.env`ファイルに以下を設定:
- `OPENAI_API_KEY`: OpenAI APIキー

3. サーバーの起動
```bash
npm start
```

## Twilio設定

1. Twilioコンソールで電話番号を取得
2. 電話番号の設定で、Voice WebhookのURLを以下に設定:
   ```
   https://your-domain.com/voice
   ```
3. HTTPメソッドをPOSTに設定

## 使用方法

1. サーバーを起動
2. Twilioの電話番号に電話をかける
3. 音声が自動的に文字起こしされ、応答が生成される

## 注意事項

- 本番環境ではHTTPSを使用してください
- ngrokを使用してローカル開発環境をTwilioに公開できます:
  ```bash
  ngrok http 3000
  ```