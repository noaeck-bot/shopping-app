const ISRAEL_TZ = 'Asia/Jerusalem';

function getIsraelDate() {
  return new Date(new Date().toLocaleString('en-US', {timeZone: ISRAEL_TZ}));
}

function isFirstSundayOfMonth(date) {
  return date.getDay() === 0 && date.getDate() <= 7;
}

function isBiweeklySunday(weekNumber) {
  return weekNumber % 2 === 0;
}

function getWeekNumber(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.ceil(((date - start) / 86400000 + start.getDay() + 1) / 7);
}

const FREQ_LABELS = {
  3:'📅 שבועי', 5:'📅 שבועי', 7:'📅 שבועי', 10:'📅 שבועי', 14:'📅 שבועי',
  21:'🗓️ דו-שבועי',
  30:'📆 חודשי', 35:'📆 חודשי',
  45:'🗃️ דו-חודשי', 60:'🗃️ דו-חודשי',
};

const SECTION_ORDER = ['📅 שבועי', '🗓️ דו-שבועי', '📆 חודשי', '🗃️ דו-חודשי'];

function buildMessage(weekly, staples, sendBiweekly, sendMonthly) {
  const stapleMap = {};
  for (const s of (staples || [])) stapleMap[s.id] = s;

  const sections = {};
  for (const item of (weekly || [])) {
    if (item.done) continue;
    const staple = item.sid ? stapleMap[item.sid] : null;
    const freq = staple ? staple.f : 7;

    if (freq > 14 && freq <= 21 && !sendBiweekly) continue;
    if (freq > 21 && !sendMonthly) continue;

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
  async scheduled(event, env, ctx) {
    const date = getIsraelDate();
    const weekNum = getWeekNumber(date);
    const sendBiweekly = isBiweeklySunday(weekNum);
    const sendMonthly = isFirstSundayOfMonth(date);

    const raw = await env.SHOPPING_DATA.get('list');
    if (!raw) return;

    const {weekly, staples} = JSON.parse(raw);
    const msg = buildMessage(weekly, staples, sendBiweekly, sendMonthly);
    if (!msg) return;
    await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
  },

  // HTTP: receives list update from the app
  async fetch(request, env, ctx) {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, {headers});

    const url = new URL(request.url);

    // POST /update — save list from app
    if (request.method === 'POST' && url.pathname === '/update') {
      const body = await request.json();
      await env.SHOPPING_DATA.put('list', JSON.stringify(body));
      return new Response(JSON.stringify({ok: true}), {headers});
    }

    // POST /send — manual trigger for testing
    if (request.method === 'POST' && url.pathname === '/send') {
      const raw = await env.SHOPPING_DATA.get('list');
      if (!raw) return new Response(JSON.stringify({ok: false, error: 'no list'}), {headers});
      const {weekly, staples} = JSON.parse(raw);
      const msg = buildMessage(weekly, staples, true, true);
      if (!msg) return new Response(JSON.stringify({ok: false, error: 'empty list'}), {headers});
      const result = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
      return new Response(JSON.stringify({ok: true, result}), {headers});
    }

    return new Response('not found', {status: 404, headers});
  }
};
