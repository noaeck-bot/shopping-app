const ISRAEL_TZ = 'Asia/Jerusalem';

function extractJSON(txt) {
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) txt = fenced[1];
  const start = txt.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < txt.length; i++) {
    if (txt[i] === '{') depth++;
    else if (txt[i] === '}') { depth--; if (depth === 0) return txt.slice(start, i + 1); }
  }
  return null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normN(n) {
  return String(n).replace(/[\u05F3\u2018\u2019\u02BC`]/g, "'").trim().toLowerCase();
}

function getIsraelDate() {
  // Use Intl parts to avoid locale-dependent string parsing
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ISRAEL_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const p = {};
  parts.forEach(({type, value}) => { p[type] = value; });
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

// Which Sunday of the month is this? (1=first, 2=second, 3=third, 4=fourth, 5=fifth)
function getSundayOfMonth(date) {
  return Math.ceil(date.getDate() / 7);
}

const FREQ_LABELS = {
  3:'📅 שבועי', 5:'📅 שבועי', 7:'📅 שבועי', 10:'📅 שבועי', 14:'📅 שבועי',
  21:'🗓️ דו-שבועי',
  30:'📆 חודשי', 35:'📆 חודשי',
  45:'🗃️ דו-חודשי', 60:'🗃️ דו-חודשי',
};

const SECTION_ORDER = ['📅 שבועי', '🗓️ דו-שבועי', '📆 חודשי', '🗃️ דו-חודשי'];

function buildMessage(weekly, staples, sendBiweekly, sendMonthly, sendBimonthly) {
  const stapleMap = {};
  for (const s of (staples || [])) stapleMap[s.id] = s;

  const sections = {};
  for (const item of (weekly || [])) {
    if (item.done) continue;
    const staple = item.sid ? stapleMap[item.sid] : null;
    const freq = staple ? staple.f : 7;

    if (freq > 14 && freq <= 21 && !sendBiweekly) continue;
    if (freq > 21 && freq <= 35 && !sendMonthly) continue;
    if (freq > 35 && !sendBimonthly) continue;

    const label = FREQ_LABELS[freq] || '📅 שבועי';
    if (!sections[label]) sections[label] = [];
    sections[label].push(`• ${item.n} × ${item.q || '1'} ${item.u || 'יח׳'}`);
  }

  if (SECTION_ORDER.every(l => !sections[l])) return null;

  const date = getIsraelDate();
  let msg = `🛒 *רשימת קניות*\n`;
  msg += `_${date.toLocaleDateString('he-IL', {weekday:'long', day:'numeric', month:'long'})}_\n\n`;

  for (const label of SECTION_ORDER) {
    if (!sections[label]) continue;
    msg += `*${label}*\n`;
    msg += sections[label].join('\n') + '\n\n';
  }

  return msg.trim();
}

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({chat_id: chatId, text, parse_mode: 'Markdown'})
  });
  return res.json();
}

export default {
  // Cron: runs every Sunday at 6am Israel time (4am UTC)
  // Schedule:
  //   1st Sunday: weekly + bi-weekly + monthly + bi-monthly (odd months: Apr,Jun,Aug,Oct,Dec,Feb)
  //   2nd Sunday: weekly only
  //   3rd Sunday: weekly + bi-weekly
  //   4th Sunday: weekly only
  //   5th Sunday: weekly + bi-weekly
  async scheduled(event, env, ctx) {
    const date = getIsraelDate();
    const sundayOfMonth = getSundayOfMonth(date);
    const sendBiweekly  = sundayOfMonth % 2 === 1;
    const sendMonthly   = sundayOfMonth === 1;
    const sendBimonthly = sundayOfMonth === 1 && date.getMonth() % 2 === 1;

    const raw = await env.SHOPPING_DATA.get('list');
    if (!raw) return;

    // Stored data is full S — extract weekly + staples
    let parsed; try { parsed = JSON.parse(raw); } catch(e) { return; }
    const weekly = parsed.weekly || [];
    const staples = parsed.staples || [];

    const msg = buildMessage(weekly, staples, sendBiweekly, sendMonthly, sendBimonthly);
    if (!msg) return;
    await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
  },

  async fetch(request, env, ctx) {
    // Allow the configured origin (env.ALLOWED_ORIGIN), fallback to GitHub Pages URL.
    // Set ALLOWED_ORIGIN in Cloudflare Worker env vars to lock down further.
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://noaeck-bot.github.io';
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = (origin === allowedOrigin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))
      ? origin : allowedOrigin;

    const headers = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, {headers});

    const url = new URL(request.url);

    // GET /sync — return stored state for cross-device sync
    if (request.method === 'GET' && url.pathname === '/sync') {
      const raw = await env.SHOPPING_DATA.get('list');
      if (!raw) return new Response('null', {headers: {...headers, 'Content-Type': 'application/json'}});
      return new Response(raw, {headers: {...headers, 'Content-Type': 'application/json'}});
    }

    // POST /update — save full S from app
    if (request.method === 'POST' && url.pathname === '/update') {
      const body = await request.json();
      await env.SHOPPING_DATA.put('list', JSON.stringify(body));
      return new Response(JSON.stringify({ok: true}), {headers});
    }

    // POST /send — manual trigger for testing
    if (request.method === 'POST' && url.pathname === '/send') {
      const raw = await env.SHOPPING_DATA.get('list');
      if (!raw) return new Response(JSON.stringify({ok: false, error: 'no list'}), {headers});
      let parsed; try { parsed = JSON.parse(raw); } catch(e) { return new Response(JSON.stringify({ok: false, error: 'corrupt data'}), {headers}); }
      const msg = buildMessage(parsed.weekly||[], parsed.staples||[], true, true, true);
      if (!msg) return new Response(JSON.stringify({ok: false, error: 'empty list'}), {headers});
      const result = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
      return new Response(JSON.stringify({ok: true, result}), {headers});
    }

    // POST /webhook — Telegram webhook (receipt photos → update shopping list)
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const update = await request.json();
      const msg = update.message;
      if (!msg) return new Response('ok', {headers});

      // Security: only handle from the authorized chat
      const chatId = String(msg.chat.id);
      if (chatId !== String(env.TELEGRAM_CHAT_ID)) return new Response('ok', {headers});

      // TEXT MESSAGE — parse natural Hebrew text like "קניתי חלב x2 ולחם"
      if (msg.text) {
        if (!env.ANTHROPIC_API_KEY) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, '❌ מפתח API חסר בהגדרות השרת.');
          return new Response('ok', {headers});
        }
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [{
              role: 'user',
              content: `Extract grocery items that were purchased from this Hebrew message. Return JSON only: {"items":[{"name":"product name in Hebrew","qty":1}]}. Infer quantity from words like "x2", "שניים", "שלושה" etc. If no grocery items found, return {"items":[]}.

Message: ${msg.text}`
            }]
          })
        });
        const claudeData = await claudeRes.json();
        const rawText = claudeData.content?.[0]?.text || '';
        let parsed = null;
        try { const j = extractJSON(rawText); if (j) parsed = JSON.parse(j); } catch(e) {}

        if (!parsed || !parsed.items?.length) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, '🤷 לא זיהיתי פריטים בהודעה. נסה לכתוב למשל: "קניתי חלב, לחם x2, ביצים"');
          return new Response('ok', {headers});
        }

        const raw = await env.SHOPPING_DATA.get('list');
        if (!raw) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, '❌ אין נתונים שמורים באפליקציה.');
          return new Response('ok', {headers});
        }
        let S; try { S = JSON.parse(raw); } catch(e) { await sendTelegram(env.TELEGRAM_TOKEN, chatId, '❌ שגיאה בטעינת הנתונים.'); return new Response('ok', {headers}); }
        const now = new Date().toISOString();
        const matched = [];
        const purchaseItems = [];

        for (const item of parsed.items) {
          const itemNorm = normN(item.name);
          const qty = item.qty || 1;
          const weeklyMatch = (S.weekly || []).find(w =>
            !w.done && (
              normN(w.n) === itemNorm ||
              normN(w.n).includes(itemNorm) ||
              itemNorm.includes(normN(w.n))
            )
          );
          if (weeklyMatch) {
            weeklyMatch.done = true;
            matched.push(`✅ ${weeklyMatch.n}`);
            if (weeklyMatch.sid) {
              const staple = (S.staples || []).find(s => s.id === weeklyMatch.sid);
              if (staple) staple.lastOrdered = now;
            }
            purchaseItems.push({sid: weeklyMatch.sid || null, name: weeklyMatch.n, qty});
          } else {
            purchaseItems.push({sid: null, name: item.name, qty});
          }
        }

        if (!S.purchaseLog) S.purchaseLog = [];
        S.purchaseLog.unshift({id: 'p' + Date.now(), date: now, items: purchaseItems, source: 'telegram-text'});
        if (S.purchaseLog.length > 50) S.purchaseLog = S.purchaseLog.slice(0, 50);
        S.lastModified = Date.now();

        await env.SHOPPING_DATA.put('list', JSON.stringify(S));

        let reply = `🛍️ *עודכן*\n_${parsed.items.length} פריטים, ${matched.length} סומנו ברשימה_`;
        if (matched.length) reply += '\n\n' + matched.join('\n');
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, reply);
        return new Response('ok', {headers});
      }

      if (!msg.photo) return new Response('ok', {headers});

      // Guard: ANTHROPIC_API_KEY must be set as a secret in Cloudflare dashboard
      if (!env.ANTHROPIC_API_KEY) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, '❌ מפתח API חסר בהגדרות השרת. הוסף את ANTHROPIC_API_KEY ב-Cloudflare Worker.');
        return new Response('ok', {headers});
      }

      // Download the largest photo size
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await fileRes.json();
      const filePath = fileData.result.file_path;
      const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
      const imgBase64 = arrayBufferToBase64(await imgRes.arrayBuffer());
      const mediaType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

      // Call Claude Haiku vision to extract items
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              {type: 'image', source: {type: 'base64', media_type: mediaType, data: imgBase64}},
              {type: 'text', text: 'Extract all purchased grocery items from this receipt. Return JSON only: {"items":[{"name":"Hebrew product name","qty":1}]}. Use the Hebrew product names exactly as printed. Skip totals, discounts, store name, cashier info, and non-grocery services. If this is not a grocery receipt, return {"items":[]}.'}
            ]
          }]
        })
      });
      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.[0]?.text || '';
      let parsed = null;
      try { const j = extractJSON(rawText); if (j) parsed = JSON.parse(j); } catch(e) {}

      if (!parsed || !parsed.items?.length) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, '❌ לא הצלחתי לקרוא את הקבלה. נסה שוב עם תמונה ברורה יותר.');
        return new Response('ok', {headers});
      }

      // Load current state
      const raw = await env.SHOPPING_DATA.get('list');
      if (!raw) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, '❌ אין נתונים שמורים באפליקציה.');
        return new Response('ok', {headers});
      }
      let S; try { S = JSON.parse(raw); } catch(e) { await sendTelegram(env.TELEGRAM_TOKEN, chatId, '❌ שגיאה בטעינת הנתונים.'); return new Response('ok', {headers}); }
      const now = new Date().toISOString();
      const matched = [];
      const purchaseItems = [];

      for (const item of parsed.items) {
        const itemNorm = normN(item.name);
        const qty = item.qty || 1;
        // Find matching undone weekly item (exact or substring both ways)
        const weeklyMatch = (S.weekly || []).find(w =>
          !w.done && (
            normN(w.n) === itemNorm ||
            normN(w.n).includes(itemNorm) ||
            itemNorm.includes(normN(w.n))
          )
        );
        if (weeklyMatch) {
          weeklyMatch.done = true;
          matched.push(`✅ ${weeklyMatch.n}`);
          if (weeklyMatch.sid) {
            const staple = (S.staples || []).find(s => s.id === weeklyMatch.sid);
            if (staple) staple.lastOrdered = now;
          }
          purchaseItems.push({sid: weeklyMatch.sid || null, name: weeklyMatch.n, qty});
        } else {
          purchaseItems.push({sid: null, name: item.name, qty});
        }
      }

      if (!S.purchaseLog) S.purchaseLog = [];
      S.purchaseLog.unshift({id: 'p' + Date.now(), date: now, items: purchaseItems, source: 'telegram'});
      if (S.purchaseLog.length > 50) S.purchaseLog = S.purchaseLog.slice(0, 50);
      S.lastModified = Date.now();

      await env.SHOPPING_DATA.put('list', JSON.stringify(S));

      let reply = `🧾 *קבלה עובדה*\n_${parsed.items.length} פריטים זוהו, ${matched.length} עודכנו ברשימה_`;
      if (matched.length) reply += '\n\n' + matched.join('\n');
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, reply);

      return new Response('ok', {headers});
    }

    // GET /setup-webhook — one-time call to register this Worker as Telegram webhook
    if (request.method === 'GET' && url.pathname === '/setup-webhook') {
      const workerUrl = url.origin;
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?url=${workerUrl}/webhook`
      );
      const data = await res.json();
      return new Response(JSON.stringify(data), {headers: {...headers, 'Content-Type': 'application/json'}});
    }

    return new Response('not found', {status: 404, headers});
  }
};
