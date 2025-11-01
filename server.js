import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { VertexAI } from '@google-cloud/vertexai';
import { Stream } from 'stream';

// --- 環境変数から設定を読み込む (Renderで設定する) ---
const PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const LOCATION = process.env.GOOGLE_LOCATION || 'asia-northeast1';
// 秘密の鍵(JSON)は、ファイルじゃなくてテキスト全体を環境変数から読み込む
const CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!PROJECT_ID || !CREDENTIALS_JSON) {
    console.error('エラー: 環境変数 (GOOGLE_PROJECT_ID, GOOGLE_CREDENTIALS_JSON) が設定されていません。');
    process.exit(1);
}

// 環境変数から読み込んだJSONテキストを使って認証
const credentials = JSON.parse(CREDENTIALS_JSON);
const vertex_ai = new VertexAI({ 
    project: PROJECT_ID, 
    location: LOCATION,
    credentials 
});

const generativeModel = vertex_ai.getGenerativeModel({
    model: 'gemini-2.5-flash-live', // (※モデル名は要確認)
});

// --- サーバーの準備 (Express + WebSocket) ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000; // Renderが指定するポートを使う

app.use(express.static('.')); 
app.use(express.json());

// --- 1. WebSocket (Live APIの中継) の処理 ---
wss.on('connection', async (ws) => {
    console.log('クライアント (ブラウザ) が接続しました。');
    
    let chat;
    try {
        chat = await generativeModel.startChat({});
        console.log('Gemini Live API との接続を開始しました。');

        const geminiStream = await chat.sendMessageStream(''); // 空のメッセージでストリーム開始
        
        // (B) Geminiから文字起こしが返ってきたら...
        (async () => {
            try {
                for await (const item of geminiStream.stream) {
                    if (item.candidates?.[0]?.content?.parts?.[0]?.text) {
                        const transcript = item.candidates[0].content.parts[0].text;
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'transcript', data: transcript }));
                        }
                    }
                }
            } catch (error) {
                console.error('Geminiストリーム受信エラー:', error);
            }
        })();

        // (A) ブラウザから音声データ (chunk) が送られてきたら...
        ws.on('message', async (message) => {
            // (注: この部分はVertex AI SDKの仕様に依存します)
            // 疑似的に音声データをストリームに送る (実際はSDKのオーディオストリーミングメソッドを使う)
            // ここでは簡易的に「テキストとして」送るフリをします (※本来の音声処理とは異なります)
            // chat.sendAudioChunk(message); // SDKに音声チャンクを送るメソッドがある場合
            
            // ★重要★
            // 実際の音声(Blob)をGemini Live APIに送るには、
            // SDKが要求する形式(Base64エンコードなど)に変換する必要があります。
            // このサンプルでは「音声データを中継する」部分の実装が難しいため、
            // 「接続はできる」状態までの実装になっています。
        });

    } catch (error) {
        console.error('Gemini Live APIとの接続エラー:', error);
        ws.close();
    }
    ws.on('close', () => console.log('クライアントが切断しました。'));
});

// --- 2. HTTP (話題提案) の処理 (FREETとほぼ同じ) ---
app.post('/api/suggest', async (req, res) => {
    const transcript = req.body.text;
    if (!transcript) return res.status(400).json({ error: 'No text' });
    
    const suggestionModel = vertex_ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `あなたは優秀なラジオ番組の放送作家です。以下のトーク内容を踏まえ、次に盛り上がる話題のアイデアを3つ提案してください。# トーク内容: "${transcript}" # 次の話題の提案:`;

    try {
        const result = await suggestionModel.generateContent(prompt);
        const suggestion = result.response.candidates[0].content.parts[0].text;
        res.json({ suggestion: suggestion.trim() });
    } catch (error) {
        console.error('話題提案AIエラー:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- サーバー起動 ---
server.listen(PORT, () => {
    console.log(`Broadster-Live サーバー起動中 (Port: ${PORT})`);
});
