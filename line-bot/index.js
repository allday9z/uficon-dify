const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8000;

const CHANNEL_ID = process.env.LINE_CHANNEL_ID || '2007934301';
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || 'a7195ed6b87d67b2d8931dc3c3723583';
const DIFY_API_URL = process.env.DIFY_API_URL || 'http://api:5001/v1';
const DIFY_API_KEY = process.env.DIFY_API_KEY || 'app-fouUlNalchxh8oq5H7S9VQAD';
const SYSTEMONE_API_URL = process.env.SYSTEMONE_API_URL || 'http://100.121.91.32:8000/v1/systemone';

// Developers (Test access ONLY - NEVER receive HR alerts)
const DEV_KEYWORDS = (process.env.DEV_KEYWORDS || 'mneodev,m2dev,m2,pongpisut,mneo').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const DEV_USER_IDS = (process.env.DEV_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// HR Admin Roster by Tier
const HR_ADMIN_ROSTER = {
  general: [
    { userId: 'Ue67823b2ebf91772cb6686ed4c883e94', name: 'HR Admin Pa' },
    { userId: 'U7b23e41e3468860947ad8ce6ce0dc668', name: 'HR Admin Blink' }
  ],
  medium_hard: [
    { userId: 'U9a3e5ca77601d85e69dd664857797c1f', name: 'HR Senior Fluke' }
  ],
  hard: [
    { userId: 'Uaa5c8a9d5ddf84dbb672ac9a687aed4e', name: 'HR Supervisor Note' }
  ]
};

// All HR user IDs for whitelisting & testing (Only the 4 HR staff)
const ALL_HR_USER_IDS = [
  'Ue67823b2ebf91772cb6686ed4c883e94', // HR Admin Pa
  'U7b23e41e3468860947ad8ce6ce0dc668', // HR Admin Blink
  'U9a3e5ca77601d85e69dd664857797c1f', // HR Senior Fluke
  'Uaa5c8a9d5ddf84dbb672ac9a687aed4e'  // HR Supervisor Note
];

const HR_KEYWORDS = (process.env.HR_KEYWORDS || 'hr,admin,บุคคล,fluke,note,blink,pa').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

// Test Mode: restricts testing to Devs & HR Staff
const TEST_MODE = process.env.TEST_MODE !== 'false';
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

let cachedToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
let tokenExpiry = 0;

async function evaluateWithSystemOne(query) {
  if (!SYSTEMONE_API_URL) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500); // 3.5s timeout
    const res = await fetch(SYSTEMONE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        state: query,
        questions: {
          needs_human: {
            type: 'noul',
            instructions: 'ข้อความนี้เป็นการขอยืมเงิน ร้องเรียน ร้องทุกข์ ต้องการติดต่อคน หรือต้องการให้เจ้าหน้าที่ฝ่ายบุคคลเข้ามาตอบแทนบอทหรือไม่'
          },
          severity: {
            type: 'choice',
            instructions: 'ประเมินระดับความยากและความสำคัญของปัญหา เพื่อเลือกส่งต่อเจ้าหน้าที่ฝ่ายบุคคลที่เหมาะสม',
            criteria: {
              hard: 'เคสที่ยากมาก หรือต้องตัดสินใจระดับหัวหน้า เช่น ขอยืมเงิน ร้องเรียนเรื่องร้ายแรง วินัย ปัญหาวิกฤต หรือขออนุมัติพิเศษ (ส่งให้ HR Supervisor Note)',
              medium_hard: 'เคสระดับปานกลางถึงยาก ปัญหาเรื่องระเบียบนโยบายที่ซับซ้อน ปัญหาทางเทคนิค การยื่นเอกสารที่ต้องพิจารณาพิเศษ (ส่งให้ HR Senior Fluke)',
              general: 'เคสทั่วไปที่ไม่มีข้อมูลในระบบ คำถามเรื่องสวัสดิการ วันลา การขอเอกสารทั่วไป ข้อมูลการทำงาน (ส่งให้ HR Admin Pa และ Blink)'
            }
          }
        }
      })
    });
    clearTimeout(timeout);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('[LINE-BOT] SystemOne call failed:', err.message);
  }
  return null;
}

async function notifyAdmin({ displayName, userId, query, reason, details, severity = 'general' }) {
  console.log(`[LINE-BOT] Routing Alert (Severity: ${severity}) for query from [${displayName}]: "${query}"`);

  let targetAdmins = [];
  let tierTitle = '';
  let employeeNote = '';

  if (severity === 'hard') {
    targetAdmins = HR_ADMIN_ROSTER.hard;
    tierTitle = 'เคสยาก / ตัดสินใจระดับบริหาร (HR Supervisor Note)';
    employeeNote = 'หัวหน้าฝ่ายบุคคล (HR Supervisor Note)';
  } else if (severity === 'medium_hard') {
    targetAdmins = HR_ADMIN_ROSTER.medium_hard;
    tierTitle = 'เคสปานกลาง - ยาก (HR Senior Fluke)';
    employeeNote = 'เจ้าหน้าที่ฝ่ายบุคคลอาวุโส (HR Senior Fluke)';
  } else {
    targetAdmins = HR_ADMIN_ROSTER.general;
    tierTitle = 'แจ้งเตือนทั่วไป (HR Admin Pa / Blink)';
    employeeNote = 'เจ้าหน้าที่ฝ่ายบุคคล (HR Admin)';
  }

  // STRICT FILTER: Exclude developers and the asking user themselves!
  const filtered = targetAdmins.filter(admin => !DEV_USER_IDS.includes(admin.userId) && admin.userId !== userId);

  console.log(`[LINE-BOT] Sending alert to ${filtered.length} admin(s) in tier [${tierTitle}]...`);

  for (const admin of filtered) {
    try {
      const alertMsg = 
        `🚨 [UFicon HR Alert — ${tierTitle}]\n\n` +
        `👤 พนักงาน: ${displayName || 'พนักงาน'}\n` +
        `💬 ข้อความ: "${query}"\n` +
        `🎯 การประเมิน: ${details || reason}\n\n` +
        `👉 ตอบแชทพนักงานได้ที่: https://chat.line.biz/`;

      await sendReply(null, admin.userId, alertMsg);
      console.log(`[LINE-BOT] Successfully pushed alert to ${admin.name} (${admin.userId})`);
    } catch (e) {
      console.warn(`[LINE-BOT] Failed to push alert to ${admin.name} (${admin.userId}):`, e.message);
    }
  }

  return employeeNote;
}




async function getChannelAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return process.env.LINE_CHANNEL_ACCESS_TOKEN;
  }
  try {
    console.log('[LINE-BOT] Requesting Channel Access Token via LINE OAuth (client_credentials)...');
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', CHANNEL_ID);
    params.append('client_secret', CHANNEL_SECRET);

    const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const data = await res.json();
    if (data.access_token) {
      cachedToken = data.access_token;
      tokenExpiry = Date.now() + ((data.expires_in || 2592000) - 3600) * 1000;
      console.log('[LINE-BOT] Successfully acquired Channel Access Token!');
      return cachedToken;
    } else {
      console.error('[LINE-BOT] Failed to obtain token from LINE OAuth:', data);
    }
  } catch (err) {
    console.error('[LINE-BOT] OAuth token request error:', err);
  }
  return cachedToken;
}

async function getUserProfile(userId) {
  try {
    const token = await getChannelAccessToken();
    if (!token) return null;
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('[LINE-BOT] Error fetching profile:', e);
  }
  return null;
}

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
    test_mode: TEST_MODE,
    allowed_users_count: ALLOWED_USER_IDS.length,
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

      // Process message in background
      handleMessage(userText, userId, replyToken).catch(err => {
        console.error('[LINE-BOT] Error processing message:', err);
      });
    }
  }
});

async function handleMessage(query, userId, replyToken) {
  try {
    const profile = await getUserProfile(userId);
    const displayName = profile ? profile.displayName : '';
    console.log(`[LINE-BOT] Incoming message from [${displayName || 'Unknown'} | ${userId}]: "${query}"`);

    // Check developer (allowed to test, but NEVER receives HR alerts)
    const isDev = (displayName && DEV_KEYWORDS.some(k => displayName.toLowerCase().includes(k))) || DEV_USER_IDS.includes(userId);
    if (isDev && !DEV_USER_IDS.includes(userId)) {
      DEV_USER_IDS.push(userId);
      console.log(`[LINE-BOT] Developer registered: "${displayName}" (${userId}) [Exempt from HR notifications]`);
    }

    // Check HR Staff (by explicit User ID or keyword in displayName)
    const isHrByKeyword = displayName && HR_KEYWORDS.some(k => displayName.toLowerCase().includes(k));
    const isHrStaff = ALL_HR_USER_IDS.includes(userId) || isHrByKeyword;
    if (isHrStaff && !ALL_HR_USER_IDS.includes(userId)) {
      ALL_HR_USER_IDS.push(userId);
      console.log(`[LINE-BOT] Auto-whitelisted HR staff: "${displayName}" (${userId})`);
    }

    // Whitelist verification for test mode
    let isAllowed = false;
    if (!TEST_MODE) {
      isAllowed = true;
    } else {
      if (ALLOWED_USER_IDS.includes(userId) || isDev || isHrStaff) {
        isAllowed = true;
        if (!ALLOWED_USER_IDS.includes(userId)) {
          ALLOWED_USER_IDS.push(userId);
          console.log(`[LINE-BOT] Whitelisted user "${displayName}" (${userId})!`);
        }
      }
    }

    if (!isAllowed) {
      console.log(`[LINE-BOT] Access denied in test mode for: ${displayName || 'Unknown'} (${userId}) - SILENT DROP (no reply sent)`);
      // SILENT DROP: Do NOT reply anything back to general users during test mode!
      return;
    }

    // Step 1: Pre-evaluate query with System 1 (OpenThai-SystemOne on ServerAI)
    console.log(`[LINE-BOT] Checking System 1 decision on ServerAI for: "${query}"...`);
    const sys1 = await evaluateWithSystemOne(query);
    if (sys1 && sys1.answers) {
      const needsHumanProb = sys1.answers.needs_human ? sys1.answers.needs_human.noul : 0;
      const severity = sys1.answers.severity ? sys1.answers.severity.choice : 'general';
      console.log(`[LINE-BOT] System 1 result: needs_human=${needsHumanProb.toFixed(3)}, severity=${severity}`);

      if (needsHumanProb > 0.65) {
        console.log(`[LINE-BOT] Escalation detected by System 1! Routing to: ${severity}`);
        const employeeNote = await notifyAdmin({
          displayName,
          userId,
          query,
          reason: 'ตรวจจับเรื่องเร่งด่วน/ต้องการผู้ดูแล',
          details: `ระดับความยาก: ${severity} (ความมั่นใจ ${(needsHumanProb * 100).toFixed(0)}%)`,
          severity: severity
        });

        const fallbackMsg = `ขออภัยครับ ไม่พบข้อมูลในระบบเบื้องต้น\n\nขณะนี้ระบบได้ส่งเรื่องแจ้งเตือนไปยัง${employeeNote}เรียบร้อยแล้วครับ เจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดครับ\n\n(หากเป็นเรื่องเร่งด่วน สามารถติดต่อฝ่ายบุคคลได้โดยตรงครับ)`;
        await sendReply(replyToken, userId, fallbackMsg);
        return;
      }
    }

    // Step 2: Query Dify Knowledge Base & Assistant
    console.log(`[LINE-BOT] Calling Dify API for: ${displayName || userId}...`);
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
    let answer = difyData.answer || 'ขออภัยครับ ไม่พบข้อมูลในระบบเบื้องต้น กรุณารอผู้ดูแลตอบกลับสักครู่นะครับ';

    // Strip <think>...</think> reasoning tags
    answer = answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Step 3: Check if Dify output is fallback -> Alert General HR Admins as well!
    if (answer.includes('ไม่พบข้อมูลในระบบเบื้องต้น') || answer.includes('รอผู้ดูแล')) {
      console.log(`[LINE-BOT] Dify returned fallback response. Alerting General HR admins...`);
      await notifyAdmin({
        displayName,
        userId,
        query,
        reason: 'ไม่พบคำตอบในฐานข้อมูล (Knowledge Base Miss)',
        details: 'คำถามทั่วไปที่ไม่มีในฐานข้อมูล',
        severity: 'general'
      });

      if (!answer.includes('ส่งเรื่องแจ้งเตือน')) {
        answer += '\n\n(ขณะนี้ระบบได้ส่งเรื่องแจ้งเตือนไปยังเจ้าหน้าที่ฝ่ายบุคคล (HR Admin) เรียบร้อยแล้วครับ เจ้าหน้าที่จะเข้ามาตอบกลับโดยเร็วที่สุด)';
      }
    }

    console.log(`[LINE-BOT] Answering user (${answer.length} chars). Sending to LINE...`);
    await sendReply(replyToken, userId, answer);
  } catch (error) {
    console.error('[LINE-BOT] Exception in handleMessage:', error);
    await sendReply(replyToken, userId, 'ขออภัยครับ เกิดข้อผิดพลาดในการประมวลผลคำตอบ');
  }
}

async function sendReply(replyToken, userId, text) {
  const token = await getChannelAccessToken();
  if (!token) {
    console.warn('[LINE-BOT] Cannot reply: LINE Channel Access Token could not be acquired.');
    return;
  }

  // Direct push message when replyToken is not available
  if (!replyToken) {
    if (userId && userId !== 'employee') {
      try {
        console.log(`[LINE-BOT] Direct push message to user ${userId}...`);
        const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            to: userId,
            messages: [{ type: 'text', text: text }]
          })
        });
        if (pushRes.ok) {
          console.log(`[LINE-BOT] Push message sent successfully to ${userId}.`);
        } else {
          const errData = await pushRes.json();
          console.warn(`[LINE-BOT] Push message failed to ${userId}:`, errData);
        }
      } catch (e) {
        console.error('[LINE-BOT] Push message exception:', e);
      }
    }
    return;
  }

  // Otherwise, use replyMessage
  try {
    const replyRes = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
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

    // Fallback to pushMessage if replyToken expired or invalid
    if (userId && userId !== 'employee') {
      console.log(`[LINE-BOT] Fallback: Sending push message to user ${userId}...`);
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
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

// Pre-fetch token on boot
getChannelAccessToken().catch(e => console.error('[LINE-BOT] Initial token fetch error:', e));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[LINE-BOT] UFicon LINE OA Webhook Bridge listening on port ${PORT} (TEST_MODE: ${TEST_MODE})`);
});
