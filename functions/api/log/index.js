// Client crash / debug log ingestion + retrieval.
//   POST /api/log      — open ingest. Body: { session_id, reason, events,
//                        app_version?, audio_state? }. No auth (rate-limited
//                        implicitly by CF + the size cap below).
//   GET  /api/log?token=<LOG_TOKEN>&limit=&since=&session=&reason=
//                       — list recent logs. Token gate via LOG_TOKEN secret.
//
// Schema: schema/0002_crash_logs.sql

import { jsonResponse, errorResponse } from '../../_shared/auth.js';

// Reject anything larger than this — keeps a runaway client (or a hostile
// one) from filling the table with megabyte payloads. The Pholia ring buffer
// caps at 200 entries of a few hundred bytes each, so ~64 KB is generous.
const MAX_BODY_BYTES = 64 * 1024;

export async function onRequestPost({ request, env }) {
    let raw;
    try {
        raw = await request.text();
    } catch {
        return errorResponse('Could not read body');
    }
    if (raw.length > MAX_BODY_BYTES) {
        return errorResponse('Payload too large', 413);
    }

    let body;
    try { body = JSON.parse(raw); } catch { return errorResponse('Invalid JSON'); }

    const sessionId = String(body.session_id || '').slice(0, 64);
    const reason = String(body.reason || 'unknown').slice(0, 32);
    if (!sessionId) return errorResponse('Missing session_id');

    // events is the audio-event ring buffer. Store as-is (already short
    // strings on the client). audio_state is a small key/value snapshot of
    // currentTime / readyState / etc. at the time of send.
    const events = Array.isArray(body.events) ? body.events : [];
    const eventsJson = JSON.stringify(events);
    const audioState = body.audio_state ? JSON.stringify(body.audio_state).slice(0, 4096) : null;
    const appVersion = body.app_version ? String(body.app_version).slice(0, 64) : null;
    const userAgent = (request.headers.get('User-Agent') || '').slice(0, 256);

    const id = crypto.randomUUID();
    try {
        await env.DB.prepare(
            'INSERT INTO crash_logs (id, session_id, reason, app_version, user_agent, audio_state, events_count, events_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, sessionId, reason, appVersion, userAgent, audioState, events.length, eventsJson).run();
    } catch (e) {
        return errorResponse(`DB error: ${e.message}`, 500);
    }
    return jsonResponse({ ok: true, id });
}

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!env.LOG_TOKEN || token !== env.LOG_TOKEN) {
        return errorResponse('Forbidden', 403);
    }

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 500);
    const since = url.searchParams.get('since');
    const session = url.searchParams.get('session');
    const reason = url.searchParams.get('reason');

    const where = [];
    const args = [];
    if (since) { where.push('ts >= ?'); args.push(since); }
    if (session) { where.push('session_id = ?'); args.push(session); }
    if (reason) { where.push('reason = ?'); args.push(reason); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Optional ?summary=1 returns metadata only (no events_json) so you can
    // browse the list without pulling kilobytes per row.
    const summary = url.searchParams.get('summary') === '1';
    const cols = summary
        ? 'id, ts, session_id, reason, app_version, events_count'
        : 'id, ts, session_id, reason, app_version, user_agent, audio_state, events_count, events_json';

    const { results } = await env.DB.prepare(
        `SELECT ${cols} FROM crash_logs ${whereSql} ORDER BY ts DESC LIMIT ?`
    ).bind(...args, limit).all();

    return jsonResponse({ logs: results || [] });
}
