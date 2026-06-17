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

// Convert raw Meta timestamp to Albanian hour (0-23)
function albHour(ts) {
  const ms = ts > 1e10 ? ts : ts * 1000;
  return (new Date(ms).getUTCHours() + ALB_OFFSET_H) % 24;
}

// Albanian date string (YYYY-MM-DD) handles midnight crossover correctly
function albDateStr(ts) {
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms + ALB_OFFSET_H * 3600 * 1000).toISOString().slice(0, 10);
}

// UTC ISO string for first_message_time storage
function toISO(ts) {
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

async function findAssignedStaff(ts) {
  const h = albHour(ts);
  const ms = ts > 1e10 ? ts : ts * 1000;

  // Shift 1 starts at 23:00 and ends 15:00 NEXT day.
  // Staff log in at start of shift -> recorded under NEXT Albanian day when h >= 23.
  // So for messages at h >= 23, query NEXT day. All other hours: query TODAY.
  let shiftDateMs = ms + ALB_OFFSET_H * 3600 * 1000;
  if (h >= 23) shiftDateMs += 86400000;
  const shiftDate = new Date(shiftDateMs).toISOString().slice(0, 10);

  const { data: shifts } = await supabase
    .from('shifts')
    .select('staff_name, start_time, end_time')
    .eq('date', shiftDate);

  if (shifts && shifts.length > 0) {
    for (const shift of shifts) {
      const sH = parseInt(shift.start_time.slice(0, 2), 10);
      const eH = parseInt(shift.end_time.slice(0, 2), 10);
      // Overnight shift (e.g. 23:00->15:00): sH > eH
      if (sH > eH) {
        if (h >= sH || h < eH) return shift.staff_name;
      } else {
        if (h >= sH && h < eH) return shift.staff_name;
      }
    }
  }

  return null; // No shift data -> unassigned
}

async function processEvent(platform, senderId, timestamp) {
  const dateStr      = albDateStr(timestamp);
  const firstMsgTime = toISO(timestamp);
  const h            = albHour(timestamp);

  const { data: existing, error: selErr } = await supabase
    .from('meta_conversations')
    .select('id')
    .eq('platform', platform)
    .eq('sender_id', senderId)
    .eq('conversation_date', dateStr)
    .maybeSingle();

  if (selErr) { console.error('SELECT error:', selErr.message); return; }
  if (existing) return;

  const assignedStaff = await findAssignedStaff(timestamp);

  console.log('NEW ' + platform + ' from ' + senderId + ' | Albanian ' + dateStr + ' ' + String(h).padStart(2,'0') + ':xx | -> ' + assignedStaff);

  const { error: insErr } = await supabase
    .from('meta_conversations')
    .insert({
      platform,
      sender_id:          senderId,
      conversation_date:  dateStr,
      first_message_time: firstMsgTime,
      assigned_staff:     assignedStaff
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
