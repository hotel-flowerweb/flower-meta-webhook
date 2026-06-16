/**
 * Flower Hotel — Meta Webhook (Netlify Function)
 * File: netlify/functions/meta-webhook.js
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TURN1_START = 8;
const TURN1_END   = 15;
const TURN2_END   = 23;

function toISODate(ts) {
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function toTimeStr(ts) {
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms).toTimeString().slice(0, 5);
}

async function findAssignedStaff(dateStr, timeStr) {
  const hour = parseInt(timeStr.slice(0, 2), 10);
  const { data: shifts } = await supabase
    .from('shifts')
    .select('staff_name, start_time, end_time')
    .eq('date', dateStr);

  if (!shifts || shifts.length === 0) {
    if (hour >= TURN1_START && hour < TURN1_END) return 'Sara';
    if (hour >= TURN1_END   && hour < TURN2_END) return 'Inva';
    return null;
  }

  for (const shift of shifts) {
    const sHour = parseInt(shift.start_time.slice(0, 2), 10);
    const eHour = parseInt(shift.end_time.slice(0, 2), 10);
    if (hour >= sHour && hour < eHour) return shift.staff_name;
  }
  return null;
}

async function processEvent(platform, senderId, timestamp) {
  const dateStr = toISODate(timestamp);
  const timeStr = toTimeStr(timestamp);
  const ms = timestamp > 1e10 ? timestamp : timestamp * 1000;
  const firstMessageTime = new Date(ms).toISOString();

  const { data: existing, error: selErr } = await supabase
    .from('meta_conversations')
    .select('id')
    .eq('platform', platform)
    .eq('sender_id', senderId)
    .eq('conversation_date', dateStr)
    .maybeSingle();

  if (selErr) { console.error('SELECT error:', selErr.message); return; }
  if (existing) return;

  const assignedStaff = await findAssignedStaff(dateStr, timeStr);

  const { error: insErr } = await supabase
    .from('meta_conversations')
    .insert({ platform, sender_id: senderId, conversation_date: dateStr, first_message_time: firstMessageTime, assigned_staff: assignedStaff });

  if (insErr && insErr.code !== '23505') {
    console.error('INSERT error:', insErr.message);
  } else {
    console.log('SAVED:', platform, senderId, dateStr, assignedStaff);
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
      console.log('ENTRY id:', entry.id, '| messaging:', (entry.messaging||[]).length, '| changes:', (entry.changes||[]).length);

      if (object === 'page') {
        for (const msg of entry.messaging || []) {
          if (!msg.message || msg.message.is_echo) continue;
          if (msg.delivery || msg.read) continue;
          console.log('MESSENGER from:', msg.sender.id);
          await processEvent('messenger', msg.sender.id, msg.timestamp);
        }
      }

      if (object === 'instagram') {
        for (const msg of entry.messaging || []) {
          if (!msg.message || msg.message.is_echo) continue;
          console.log('INSTAGRAM messaging from:', msg.sender.id);
          await processEvent('instagram', msg.sender.id, msg.timestamp);
        }
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const val = change.value || {};
          if (!val.message || val.message.is_echo) continue;
          if (val.sender) {
            console.log('INSTAGRAM changes from:', val.sender.id);
            await processEvent('instagram', val.sender.id, val.timestamp);
          }
        }
      }
    }

    return { statusCode: 200, body: 'EVENT_RECEIVED' };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
