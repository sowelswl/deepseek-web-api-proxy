#!/usr/bin/env node
/**
 * DeepSeek Web API Proxy — OpenAI-compatible server
 * 
 * Wraps DeepSeek's free web chat API (chat.deepseek.com) as a standard
 * OpenAI /v1/chat/completions endpoint. Supports streaming, tool calling,
 * multi-session isolation, auto-recovery, and retry with fresh sessions.
 * 
 * Usage:  node server.js
 *         PORT=9655 node server.js
 * 
 * License: MIT
 */

const http = require('http');
const fs = require('fs');
const os = require('os');

// === Config ===
const PORT = parseInt(process.env.PORT || '9654', 10);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_CONFIG_PATH = process.env.AUTH_CONFIG_PATH || __dirname + '/auth.json';
const SERVER_HOST = os.hostname();
const SERVER_PUBLIC_IP = (() => {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return 'localhost';
})();

// === Session Store ===
const sessions = new Map();
const MAX_HISTORY_LENGTH = 5;
const MAX_HISTORY_CHARS = 3000;
const MAX_MESSAGE_DEPTH = 100;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// === DeepSeek Config ===
let DS_CONFIG = {};
function loadConfig() {
    try {
        const raw = fs.readFileSync(AUTH_CONFIG_PATH, 'utf8');
        DS_CONFIG = JSON.parse(raw);
        console.log(`[DS-Proxy] Loaded auth config from ${AUTH_CONFIG_PATH}`);
    } catch (e) {
        console.error(`[DS-Proxy] FATAL: ${e.message}`);
        process.exit(1);
    }
}
loadConfig();

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    'X-Client-Platform': 'web', 'X-Client-Version': '1.0.0-always',
    'X-Client-Locale': 'en_US', 'X-App-Version': '20241129.1',
    'Authorization': `Bearer ${DS_CONFIG.token}`,
    'x-hif-dliq': DS_CONFIG.hif_dliq, 'x-hif-leim': DS_CONFIG.hif_leim,
    'Origin': 'https://chat.deepseek.com', 'Referer': 'https://chat.deepseek.com/',
    'Cookie': DS_CONFIG.cookie, 'Content-Type': 'application/json',
};

function createSession() {
    return { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] };
}

function getOrCreateSession(agentId) {
    if (!sessions.has(agentId)) sessions.set(agentId, createSession());
    return sessions.get(agentId);
}

async function solvePOW(challenge) {
    const resp = await fetch(DS_CONFIG.wasmUrl);
    const wasmBytes = await resp.arrayBuffer();
    const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
    const e = mod.instance.exports;
    const encoder = new TextEncoder();
    const prefix = challenge.salt + '_' + challenge.expire_at + '_';
    const cBytes = encoder.encode(challenge.challenge);
    const pBytes = encoder.encode(prefix);
    const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
    const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
    new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
    new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);
    const sp = e.__wbindgen_add_to_stack_pointer(-16);
    e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
    const dv = new DataView(e.memory.buffer);
    const code = dv.getInt32(sp, true);
    const ans = dv.getFloat64(sp + 8, true);
    e.__wbindgen_add_to_stack_pointer(16);
    if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error('POW failed');
    return Math.floor(ans);
}

async function askDeepSeekStream(prompt, agentId) {
    const session = getOrCreateSession(agentId);
    const tag = `[${agentId}]`;

    // Auto-reset on deep message chain
    if (session.id && session.messageCount >= MAX_MESSAGE_DEPTH) {
        console.log(`${tag} Session ${session.id} hit ${session.messageCount}msgs. Resetting.`);
        Object.assign(session, createSession());
    }

    // Reset expired sessions
    if (session.id && session.createdAt && (Date.now() - session.createdAt > SESSION_TTL_MS)) {
        console.log(`${tag} Session ${session.id} expired. Creating new...`);
        Object.assign(session, createSession());
    }

    // Get POW challenge
    const cr = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
        method: 'POST', headers: BASE_HEADERS,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion', scene: 'completion_like' })
    });
    const chalJson = JSON.parse(await cr.text());
    const challenge = chalJson.data.biz_data.challenge;
    const answer = await solvePOW(challenge);

    // Create or reuse session
    if (!session.id) {
        const sr = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
            method: 'POST', headers: BASE_HEADERS, body: '{}'
        });
        const sessionData = await sr.json();
        session.id = sessionData.data.biz_data.id;
        session.parentMessageId = null;
        session.createdAt = Date.now();
        session.messageCount = 0;
        console.log(`${tag} New session: ${session.id}`);
    }

    const powB64 = Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: '/api/v0/chat/completion'
    })).toString('base64');

    const resp = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...BASE_HEADERS, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify({
            chat_session_id: session.id,
            parent_message_id: session.parentMessageId,
            model_type: 'default',
            prompt, ref_file_ids: [],
            thinking_enabled: false, search_enabled: false, user_options: {},
        })
    });

    // Retry on session error
    if (resp.status !== 200) {
        const errText = await resp.text();
        console.log(`${tag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        if ([400, 404, 500].includes(resp.status)) {
            console.log(`${tag} Session expired. Resetting...`);
            Object.assign(session, createSession());

            const sr2 = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
                method: 'POST', headers: BASE_HEADERS, body: '{}'
            });
            const sd2 = await sr2.json();
            session.id = sd2.data.biz_data.id;
            session.createdAt = Date.now();

            const newPowB64 = Buffer.from(JSON.stringify({
                algorithm: challenge.algorithm, challenge: challenge.challenge,
                salt: challenge.salt, answer: answer,
                signature: challenge.signature, target_path: '/api/v0/chat/completion'
            })).toString('base64');

            const resp2 = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
                method: 'POST',
                headers: { ...BASE_HEADERS, 'X-DS-PoW-Response': newPowB64 },
                body: JSON.stringify({
                    chat_session_id: session.id,
                    parent_message_id: null,
                    model_type: 'default',
                    prompt, ref_file_ids: [],
                    thinking_enabled: false, search_enabled: false, user_options: {},
                })
            });
            return { resp: resp2, agentId };
        }
    }

    return { resp, agentId };
}

// === Tool Calling ===
function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands.\n';
    text += 'When you need data, REQUEST a tool by responding:\n';
    text += 'TOOL_CALL: <function_name>\narguments: <JSON>\n\n';
    text += 'RULES:\n1. You ONLY output the tool request\n';
    text += '2. Wait for actual results — never simulate\n';
    text += `3. The tool runs on ${SERVER_HOST} (${SERVER_PUBLIC_IP})\n`;
    text += '4. After the tool executes, the result is sent back as a user message\n';
    text += '5. The entire response must be just the TOOL_CALL — no extra text\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n${fn.description || ''}\n`;
            if (fn.parameters) text += `Parameters: ${JSON.stringify(fn.parameters, null, 2)}\n`;
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    return text;
}

function parseToolCall(text) {
    const match = text.match(/(?:^|\n)\s*[A-Z_]*CALL:\s*(\w[\w-]*)\s*\n\s*arguments:\s*/i);
    if (!match) return null;
    const name = match[1];
    const argsStart = match.index + match[0].length;
    const rest = text.substring(argsStart);
    let braceDepth = 0, inString = false, escape = false, jsonEnd = -1;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') { braceDepth--; if (braceDepth === 0) { jsonEnd = i + 1; break; } }
        }
    }
    if (jsonEnd === -1) return null;
    let args;
    try { args = JSON.parse(rest.substring(0, jsonEnd)); } catch (e) { return null; }
    return { name, arguments: JSON.stringify(args) };
}

function buildToolCallResponse(toolCall) {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-web-v3',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
}

function buildTextResponse(content, prompt) {
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-web-v3',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: Math.ceil(prompt.length / 4),
            completion_tokens: Math.ceil(content.length / 4),
            total_tokens: Math.ceil((prompt.length + content.length) / 4)
        }
    };
}

function storeHistory(agentId, prompt, content, toolCall) {
    const session = getOrCreateSession(agentId);
    const assistantResponse = toolCall
        ? `TOOL_CALL: ${toolCall.name}\narguments: ${toolCall.arguments}`
        : content;
    session.history.push({ user: prompt, assistant: assistantResponse });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let chars = session.history.reduce((s, e) => s + e.user.length + e.assistant.length, 0);
    while (chars > MAX_HISTORY_CHARS && session.history.length > 1) {
        chars -= session.history[0].user.length + session.history[0].assistant.length;
        session.history.shift();
    }
}

function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) systemPrompt += msg.content + '\n';
    }
    systemPrompt += formatToolDefinitions(tools);
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            return { prompt: messages[i].content, systemPrompt: systemPrompt.trim() };
        }
    }
    const allContent = messages.map(m => m.content).join('\n');
    return { prompt: allContent, systemPrompt: systemPrompt.trim() };
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Health check
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', model: 'deepseek-web-v3', agents: sessions.size }));
        return;
    }

    // Models list
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{
            id: 'deepseek-web-v3', object: 'model', created: Date.now(), owned_by: 'deepseek-web'
        }]}));
        return;
    }

    // Sessions status
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.id,
                message_count: session.messageCount,
                history_size: session.history.length,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    // Reset session
    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count: sessions.size }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        Object.assign(session, createSession());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount }));
        return;
    }

    // Only /v1/chat/completions
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        res.writeHead(404); res.end('Not found'); return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const params = JSON.parse(body);
            const messages = params.messages || [];
            const tools = params.tools || [];
            const stream = params.stream === true;

            // Session isolation: remote IP or explicit user field
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const agentId = (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1')
                ? (params.user || 'default')
                : (params.user || remoteAddr);
            const tag = `[${agentId}]`;
            const { prompt, systemPrompt } = formatMessages(messages, tools);

            const session = getOrCreateSession(agentId);

            // Build history prefix if starting fresh
            let historyPrefix = '';
            if (!session.id && session.history.length > 0) {
                historyPrefix = '[Previous conversation]\n';
                for (const exchange of session.history) {
                    historyPrefix += `User: ${exchange.user}\nAssistant: ${exchange.assistant}\n\n`;
                }
                historyPrefix += '[Continue from here]\n\n';
            }

            const fullPrompt = systemPrompt
                ? `${systemPrompt}\n\n${historyPrefix}${prompt}`
                : `${historyPrefix}${prompt}`;

            const startTime = Date.now();
            const { resp: dsResp } = await askDeepSeekStream(fullPrompt, agentId);

            // Read DeepSeek SSE stream
            async function readStream(readable) {
                let buf = '';
                let lastPath = null;
                let fullContent = '';
                let newMessageId = null;
                for await (const chunk of readable) {
                    buf += new TextDecoder().decode(chunk, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const d = JSON.parse(line.slice(6));
                                if (d.p !== undefined) lastPath = d.p;
                                if (d.v && typeof d.v === 'object' && d.v.response && d.v.response.message_id !== undefined) {
                                    newMessageId = d.v.response.message_id;
                                    if (d.v.response.content) fullContent = d.v.response.content;
                                }
                                if (lastPath === 'response/content' && d.v) fullContent += d.v;
                            } catch (e) {}
                        }
                    }
                }
                if (newMessageId) {
                    session.parentMessageId = newMessageId;
                    session.messageCount++;
                }
                return fullContent;
            }

            let fullContent = await readStream(dsResp.body);
            const elapsed = Date.now() - startTime;
            console.log(`${tag} Got ${fullContent.length} chars in ${elapsed}ms (msg#${session.messageCount})`);

            // Empty response — retry loop with fresh sessions
            let retryAttempt = 0;
            const MAX_RETRIES = 10;
            while (!fullContent || fullContent.trim().length === 0) {
                retryAttempt++;
                if (retryAttempt > MAX_RETRIES) {
                    console.log(`${tag} Empty after ${MAX_RETRIES} retries. Giving up.`);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: `Empty content after ${MAX_RETRIES} retries`,
                            type: 'empty_response',
                            agent: agentId, session_id: session.id,
                            message_count: session.messageCount,
                            history_length: session.history.length,
                            retry_attempts: retryAttempt - 1,
                        }
                    }));
                    return;
                }
                console.log(`${tag} Empty (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_RETRIES}). Resetting...`);
                Object.assign(session, createSession());
                await new Promise(r => setTimeout(r, Math.min(1000 * retryAttempt, 5000)));
                const { resp: retryResp } = await askDeepSeekStream(fullPrompt, agentId);
                const retryContent = await readStream(retryResp.body);
                if (retryContent && retryContent.trim().length > 0) {
                    console.log(`${tag} Retry ${retryAttempt} succeeded`);
                    fullContent = retryContent;
                }
            }

            let toolCall = parseToolCall(fullContent);
            storeHistory(agentId, prompt, fullContent, toolCall);

            if (stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                });

                if (toolCall) {
                    const tcResp = buildToolCallResponse(toolCall);
                    const delta = {
                        id: tcResp.id, object: 'chat.completion.chunk',
                        created: tcResp.created, model: 'deepseek-web-v3',
                        choices: [{ index: 0, delta: {
                            tool_calls: [{
                                index: 0, id: tcResp.choices[0].message.tool_calls[0].id,
                                type: 'function',
                                function: { name: tcResp.choices[0].message.tool_calls[0].function.name, arguments: '' }
                            }]
                        }, finish_reason: null }]
                    };
                    res.write(`data: ${JSON.stringify(delta)}\n\n`);
                    const argsChunk = {
                        id: tcResp.id, object: 'chat.completion.chunk',
                        created: tcResp.created, model: 'deepseek-web-v3',
                        choices: [{ index: 0, delta: {
                            tool_calls: [{ index: 0, function: { arguments: toolCall.arguments } }]
                        }, finish_reason: null }]
                    };
                    res.write(`data: ${JSON.stringify(argsChunk)}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        id: tcResp.id, object: 'chat.completion.chunk',
                        created: tcResp.created, model: 'deepseek-web-v3',
                        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                    })}\n\ndata: [DONE]\n\n`);
                } else {
                    for (let i = 0; i < fullContent.length; i += 50) {
                        const chunk = fullContent.substring(i, i + 50);
                        res.write(`data: ${JSON.stringify({
                            id: 'ds-' + Date.now(), object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000), model: 'deepseek-web-v3',
                            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
                        })}\n\n`);
                    }
                    res.write(`data: ${JSON.stringify({
                        id: 'ds-' + Date.now(), object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000), model: 'deepseek-web-v3',
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                    })}\n\ndata: [DONE]\n\n`);
                }
                res.end();
                console.log(`${tag} Streamed (tool=${!!toolCall}) in ${Date.now() - startTime}ms`);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (toolCall) {
                    res.end(JSON.stringify(buildToolCallResponse(toolCall)));
                } else {
                    res.end(JSON.stringify(buildTextResponse(fullContent, fullPrompt)));
                }
                console.log(`${tag} Response (tool=${!!toolCall}, ${Date.now() - startTime}ms, ${fullContent.length} chars)`);
            }
        } catch (e) {
            console.log('[DS-Proxy] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        }
    });
});

server.listen(PORT, HOST, () => {
    console.log(`[DS-Proxy] Server on http://${HOST}:${PORT}`);
    console.log(`[DS-Proxy] POST /v1/chat/completions (stream=true|false)`);
    console.log(`[DS-Proxy] GET  /v1/sessions — list active sessions`);
    console.log(`[DS-Proxy] POST /reset-session?agent=<id> — reset agent session`);
});
