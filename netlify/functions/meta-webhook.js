/**
 * Flower Hotel — Meta Webhook (Netlify Function)
 * File: netlify/functions/meta-webhook.js
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Albania = UTC+2 (CEST summer)
const ALB_OFFSET_H = 2;

// Albanian date string (YYYY-MM-DD)
function albDateStr(ts) {
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms + ALB_OFFSET_H * 3600 * 1000).toISOString().slice(0, 10);
}

// UTC ISO string for first_message_time storage
function toISO(ts) {
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

async function processEvent(platform, senderId, timestamp) {
  const dateStr      = albDateStr(timestamp);
  const firstMsgTime = toISO(timestamp);

  const { data: existing, error: selErr } = await supabase
    .from('meta_conversations')
    .select('id')
    .eq('platform', platform)
    .eq('sender_id', senderId)
    .eq('conversation_date', dateStr)
    .maybeSingle();

  if (selErr) { console.error('SELECT error:', selErr.message); return; }
  if (existing) return;

  console.log('NEW ' + platform + ' from ' + senderId + ' | ' + dateStr);

  const { error: insErr } = await supabase
    .from('meta_conversations')
    .insert({
      platform,
      sender_id:          senderId,
      conversation_date:  dateStr,
      first_message_time: firstMsgTime
    });

  if (insErr && insErr.code !== '23505') {
    console.error('INSERT error:', insErr.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const p = event.queryStringParameters || {};
    if (p['hub.mode'] === 'subscribe' && p['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
      return { statusCode: 200, body: p['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

    const object = body.object;
    console.log('WEBHOOK object:', object, '| entries:', (body.entry||[]).length);

    for (const entry of body.entry || []) {
      if (object === 'page') {
        for (const msg of entry.messaging || []) {
          if (!msg.message || msg.message.is_echo) continue;
          if (msg.delivery || msg.read) continue;
          await processEvent('messenger', msg.sender.id, msg.timestamp);
        }
      }

      if (object === 'instagram') {
        for (const msg of entry.messaging || []) {
          if (!msg.message || msg.message.is_echo) continue;
          await processEvent('instagram', msg.sender.id, msg.timestamp);
        }
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const val = change.value || {};
          if (!val.message || val.message.is_echo) continue;
          if (val.sender) {
            await processEvent('instagram', val.sender.id, val.timestamp);
          }
        }
      }
    }

    return { statusCode: 200, body: 'EVENT_RECEIVED' };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
