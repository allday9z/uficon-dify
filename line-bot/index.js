const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8000;

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || 'a7195ed6b87d67b2d8931dc3c3723583';
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const DIFY_API_URL = process.env.DIFY_API_URL || 'http://api:5001/v1';
const DIFY_API_KEY = process.env.DIFY_API_KEY || 'app-fouUlNalchxh8oq5H7S9VQAD';

// Capture raw body for LINE signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'uficon-line-dify-bridge',
    timestamp: new Date().toISOString()
  });
});

app.get('/webhook/line', (req, res) => {
  res.send('LINE Webhook Endpoint is active. Please configure POST in LINE Developers Console.');
});

// LINE Webhook handler
app.post('/webhook/line', async (req, res) => {
  const signature = req.headers['x-line-signature'];

  // Signature verification
  if (CHANNEL_SECRET && signature) {
    const hash = crypto
      .createHmac('SHA256', CHANNEL_SECRET)
      .update(req.rawBody || '')
      .digest('base64');

    if (hash !== signature) {
      console.warn('[LINE-BOT] Invalid signature received!');
      return res.status(403).send('Invalid signature');
    }
  }

  // Respond 200 OK immediately to LINE to prevent timeout
  res.status(200).send('OK');

  const events = req.body && req.body.events;
  if (!events || !Array.isArray(events) || events.length === 0) {
    console.log('[LINE-BOT] Webhook ping/verification received successfully');
    return;
  }

  for (const event of events) {
    if (event.type === 'message' && event.message && event.message.type === 'text') {
      const userText = event.message.text.trim();
      const replyToken = event.replyToken;
      const userId = event.source ? (event.source.userId || 'employee') : 'employee';

      console.log(`[LINE-BOT] Message from [${userId}]: "${userText}"`);

      // Process message in background
      handleMessage(userText, userId, replyToken).catch(err => {
        console.error('[LINE-BOT] Error processing message:', err);
      });
    }
  }
});

async function handleMessage(query, userId, replyToken) {
  try {
    console.log(`[LINE-BOT] Calling Dify API for user: ${userId}...`);
    const difyRes = await fetch(`${DIFY_API_URL}/chat-messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'User-Agent': 'UFicon-LineBot/1.0'
      },
      body: JSON.stringify({
        inputs: {},
        query: query,
        response_mode: 'blocking',
        user: userId
      })
    });

    if (!difyRes.ok) {
      const errText = await difyRes.text();
      console.error(`[LINE-BOT] Dify API returned ${difyRes.status}:`, errText);
      await sendReply(replyToken, userId, 'ขออภัยครับ ขณะนี้ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง');
      return;
    }

    const difyData = await difyRes.json();
    let answer = difyData.answer || 'ขออภัยครับ ไม่พบข้อมูลในระบบ';

    // Strip <think>...</think> reasoning tags
    answer = answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    console.log(`[LINE-BOT] Dify answered (${answer.length} chars). Sending to LINE...`);
    await sendReply(replyToken, userId, answer);
  } catch (error) {
    console.error('[LINE-BOT] Exception in handleMessage:', error);
    await sendReply(replyToken, userId, 'ขออภัยครับ เกิดข้อผิดพลาดในการประมวลผลคำตอบ');
  }
}

async function sendReply(replyToken, userId, text) {
  if (!CHANNEL_ACCESS_TOKEN) {
    console.warn('[LINE-BOT] Notice: LINE_CHANNEL_ACCESS_TOKEN is not yet set. Message generated but not sent.');
    return;
  }

  // 1. Try replyMessage
  try {
    const replyRes = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: 'text', text: text }]
      })
    });

    if (replyRes.ok) {
      console.log(`[LINE-BOT] Successfully replied to user via replyToken.`);
      return;
    }

    const errData = await replyRes.json();
    console.warn('[LINE-BOT] replyMessage failed:', errData);

    // 2. Fallback to pushMessage if replyToken expired or invalid
    if (userId && userId !== 'employee') {
      console.log(`[LINE-BOT] Fallback: Sending push message to user ${userId}...`);
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          to: userId,
          messages: [{ type: 'text', text: text }]
        })
      });
    }
  } catch (err) {
    console.error('[LINE-BOT] Exception in sendReply:', err);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[LINE-BOT] UFicon LINE OA Webhook Bridge listening on port ${PORT}`);
});
