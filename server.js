#!/usr/bin/env node
/**
 * OpenAI-compatible API server wrapping DeepSeek Web API
 * Supports BOTH streaming (SSE) and non-streaming modes
 * Includes tool calling: injects tool definitions into system prompt,
 * parses LLM text responses for TOOL_CALL patterns, returns OpenAI tool_calls format.
 * 
 * Per-agent sessions: each unique `user` field gets its own DeepSeek web session.
 * Auto-reset: sessions reset when message chain > 50 messages or age > 2 hours.
 * Listens on 0.0.0.0:9655
 */

const http = require('http');
const fs = require('fs');
const os = require('os');

const SERVER_HOST = os.hostname();  // Dynamic hostname detection
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

// === Per-Agent Session Store ===
const sessions = new Map();  // keyed by agent ID (from `user` field)
const MAX_HISTORY_LENGTH = 5;
const MAX_HISTORY_CHARS = 3000;
const MAX_MESSAGE_DEPTH = 100;  // auto-reset after this many messages
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours

// === DeepSeek Web API Config — loaded from external config file ===
const DS_CONFIG_PATH = __dirname + '/deepseek-auth.json';
let DS_CONFIG = {};
function loadDeepSeekConfig() {
    try {
        const raw = fs.readFileSync(DS_CONFIG_PATH, 'utf8');
        DS_CONFIG = JSON.parse(raw);
        console.log(`[DS-API] Loaded auth config from ${DS_CONFIG_PATH}`);
    } catch (e) {
        console.error(`[DS-API] FATAL: Could not load auth config: ${e.message}`);
        process.exit(1);
    }
}
loadDeepSeekConfig();

const BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
    "X-Client-Platform": "web", "X-Client-Version": "1.0.0-always",
    "X-Client-Locale": "en_US", "X-App-Version": "20241129.1",
    "Authorization": `Bearer ${DS_CONFIG.token}`,
    "x-hif-dliq": DS_CONFIG.hif_dliq, "x-hif-leim": DS_CONFIG.hif_leim,
    "Origin": "https://chat.deepseek.com", "Referer": "https://chat.deepseek.com/",
    "Cookie": DS_CONFIG.cookie, "Content-Type": "application/json",
};

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        history: [],
    };
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) {
        sessions.set(agentId, createSession());
    }
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
    const session = getOrCreateAgentSession(agentId);
    const agentTag = `[${agentId}]`;

    // Auto-reset on deep message chain
    if (session.id && session.messageCount >= MAX_MESSAGE_DEPTH) {
        console.log(`${agentTag} Session ${session.id} hit ${session.messageCount} messages. Auto-resetting.`);
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
        // History preserved for context injection
    }

    // Reset expired sessions (DeepSeek web sessions last ~1-2 hours)
    if (session.id && session.createdAt && (Date.now() - session.createdAt > SESSION_TTL_MS)) {
        console.log(`${agentTag} Session ${session.id} expired (age: ${Math.round((Date.now() - session.createdAt) / 60000)}min). Creating new...`);
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
    }

    const cr = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
        method: 'POST', headers: BASE_HEADERS,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion', scene: 'completion_like' })
    });
    const chalJson = JSON.parse(await cr.text());
    const challenge = chalJson.data.biz_data.challenge;
    const answer = await solvePOW(challenge);

    if (!session.id) {
        const sr = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
            method: 'POST', headers: BASE_HEADERS, body: '{}'
        });
        const sessionData = await sr.json();
        session.id = sessionData.data.biz_data.id;
        session.parentMessageId = null;
        session.createdAt = Date.now();
        session.messageCount = 0;
        console.log(`${agentTag} Created new session: ${session.id}`);
    } else {
        console.log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
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
            prompt: prompt, ref_file_ids: [],
            thinking_enabled: false, search_enabled: false, user_options: {},
        })
    });

    // If session expired, reset and retry once
    if (resp.status !== 200) {
        const errText = await resp.text();
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired. Creating new session...`);
            session.id = null;
            session.parentMessageId = null;
            session.createdAt = null;
            session.messageCount = 0;

            const sr2 = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
                method: 'POST', headers: BASE_HEADERS, body: '{}'
            });
            const sessionData2 = await sr2.json();
            session.id = sessionData2.data.biz_data.id;
            session.parentMessageId = null;
            session.createdAt = Date.now();
            console.log(`${agentTag} Created new session: ${session.id}`);

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
                    prompt: prompt, ref_file_ids: [],
                    thinking_enabled: false, search_enabled: false, user_options: {},
                })
            });
            return { resp: resp2, agentId };
        }
    }

    return { resp, agentId };
}

// === Tool Calling Support ===

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n';
    text += 'When you need data from the local server, REQUEST a tool by responding EXACTLY with:\n';
    text += 'TOOL_CALL: <function_name>\narguments: <JSON arguments>\n\n';
    text += 'Your response will be sent to the Hermes gateway, which executes the command on the LOCAL machine and sends the output back to you in the next message.\n\n';
    text += 'RULES:\n';
    text += '1. You ONLY output the tool request — you never run anything\n';
    text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n';
    text += '3. The tool runs on ' + SERVER_HOST + ' (' + SERVER_PUBLIC_IP + '), your local server — NOT on DeepSeek\n';
    text += '4. After the tool executes, the result will be sent to you as a new user message\n';
    text += '5. Never add explanation before or after the TOOL_CALL — the entire response must be just the request\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            text += `${fn.description || ''}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(fn.parameters, null, 2)}\n`;
            }
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    text += '\nREMEMBER: You are requesting a tool to run on the local server. You will receive the actual output in the next message. Never simulate results.';
    return text;
}

function parseToolCall(text) {
    // Find TOOL_CALL: anywhere in the text, followed by a function name
    const match = text.match(/TOOL_CALL:\s*(\w[\w-]*)\s*/i);
    if (!match) return null;
    const name = match[1];
    
    // Search for the first { after the match position
    const afterMatch = text.substring(match.index + match[0].length);
    const braceIdx = afterMatch.indexOf('{');
    if (braceIdx === -1) return null;
    
    const rest = afterMatch.substring(braceIdx);
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    let jsonEnd = -1;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) { jsonEnd = i + 1; break; }
            }
        }
    }
    if (jsonEnd === -1) return null;
    const rawJson = rest.substring(0, jsonEnd);
    let args;
    try { args = JSON.parse(rawJson); } catch (e) { return null; }
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
                tool_calls: [{
                    id: id,
                    type: 'function',
                    function: { name: toolCall.name, arguments: toolCall.arguments }
                }]
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
        choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: Math.ceil(prompt.length / 4),
            completion_tokens: Math.ceil(content.length / 4),
            total_tokens: Math.ceil((prompt.length + content.length) / 4)
        }
    };
}

function storeHistory(agentId, prompt, content, toolCall) {
    const session = getOrCreateAgentSession(agentId);
    const assistantResponse = toolCall
        ? `TOOL_CALL: ${toolCall.name}\narguments: ${toolCall.arguments}`
        : content;
    // Save last 200 chars of the prompt for history context
    const shortPrompt = prompt.length > 200 ? '...' + prompt.substring(prompt.length - 200) : prompt;
    session.history.push({ user: shortPrompt, assistant: assistantResponse });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
}

function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) {
            systemPrompt += msg.content + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);

    // Build full conversation history for DeepSeek's context
    let conversation = '';
    for (const msg of messages) {
        if (msg.role === 'system') continue;  // already in systemPrompt
        if (msg.role === 'user' && msg.content) {
            conversation += `User: ${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // This was a tool call response from a previous turn
                for (const tc of msg.tool_calls) {
                    conversation += `Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}\n\n`;
                }
            } else if (msg.content) {
                conversation += `Assistant: ${msg.content}\n\n`;
            }
        } else if (msg.role === 'tool' && msg.content) {
            // Tool execution result — send back to DeepSeek as context
            const truncated = msg.content.length > 2000
                ? msg.content.substring(0, 2000) + '\n...[truncated]'
                : msg.content;
            conversation += `[Tool Result]\n${truncated}\n\n`;
        }
    }
    // The last user message + full conversation context
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
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

    // Models
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'deepseek-web-v3', object: 'model', created: Date.now(), owned_by: 'deepseek-web' }] }));
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

    // Reset session for a specific agent (or all if no agent specified)
    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        const historyPreview = session.history.map(e => e.user.substring(0, 40)).join(' | ');
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview }));
        return;
    }

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
            // Use remote IP for session isolation (local gets 'dev-agent', external per-IP)
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const agentId = (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1')
                ? 'dev-agent'
                : (params.user || remoteAddr);
            const agentTag = `[${agentId}]`;
            const { prompt, systemPrompt } = formatMessages(messages, tools);

            const session = getOrCreateAgentSession(agentId);

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

            // Process streaming response from DeepSeek
            async function readDeepSeekResponse(readable) {
                let buffer = '';
                let lastPath = null;
                let fullContent = '';
                let newMessageId = null;

                for await (const chunk of readable) {
                    buffer += new TextDecoder().decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const d = JSON.parse(line.slice(6));
                                if (d.p !== undefined) lastPath = d.p;
                                if (d.v && typeof d.v === 'object' && d.v.response && d.v.response.message_id !== undefined) {
                                    newMessageId = d.v.response.message_id;
                                    if (d.v.response.content) {
                                        fullContent = d.v.response.content;
                                    }
                                }
                                if (lastPath === 'response/content' && d.v) {
                                    fullContent += d.v;
                                }
                            } catch (e) { }
                        }
                    }
                }

                if (newMessageId) {
                    session.parentMessageId = newMessageId;
                    session.messageCount++;
                } else {
                    console.log(`${agentTag} WARNING: could not extract message_id`);
                }

                return fullContent;
            }

            let fullContent = await readDeepSeekResponse(dsResp.body);
            const elapsed = Date.now() - startTime;
            console.log(`${agentTag} Got ${fullContent.length} chars in ${elapsed}ms (msg#${session.messageCount})`);

            // Empty response — retry loop with fresh sessions
            let retryAttempt = 0;
            const MAX_RETRIES = 10;
            while (!fullContent || fullContent.trim().length === 0) {
                retryAttempt++;
                if (retryAttempt > MAX_RETRIES) {
                    console.log(`${agentTag} Empty after ${MAX_RETRIES} retries. Giving up.`);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        error: { 
                            message: `DeepSeek returned empty content after ${MAX_RETRIES} retries`, 
                            type: 'empty_response',
                            agent: agentId,
                            session_id: session.id,
                            message_count: session.messageCount,
                            history_length: session.history.length,
                            retry_attempts: retryAttempt - 1,
                        } 
                    }));
                    return;
                }
                console.log(`${agentTag} Empty response (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_RETRIES}). Resetting session...`);
                session.id = null;
                session.parentMessageId = null;
                session.createdAt = null;
                session.messageCount = 0;
                // Brief delay before retry to let DeepSeek breathe
                await new Promise(r => setTimeout(r, Math.min(1000 * retryAttempt, 5000)));
                const { resp: retryResp } = await askDeepSeekStream(fullPrompt, agentId);
                const retryContent = await readDeepSeekResponse(retryResp.body);
                if (retryContent && retryContent.trim().length > 0) {
                    console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
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
                        id: tcResp.id,
                        object: 'chat.completion.chunk',
                        created: tcResp.created,
                        model: 'deepseek-web-v3',
                        choices: [{
                            index: 0,
                            delta: { role: 'assistant', content: null, tool_calls: tcResp.choices[0].message.tool_calls },
                            finish_reason: null
                        }]
                    };
                    res.write(`data: ${JSON.stringify(delta)}\n\n`);
                    const stopDelta = {
                        id: tcResp.id,
                        object: 'chat.completion.chunk',
                        created: tcResp.created,
                        model: 'deepseek-web-v3',
                        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                    };
                    res.write(`data: ${JSON.stringify(stopDelta)}\n\ndata: [DONE]\n\n`);
                } else {
                    const created = Math.floor(Date.now() / 1000);
                    const id = 'ds-' + Date.now();
                    for (let i = 0; i < fullContent.length; i += 50) {
                        const chunk = fullContent.substring(i, i + 50);
                        res.write(`data: ${JSON.stringify({
                            id, object: 'chat.completion.chunk',
                            created, model: 'deepseek-web-v3',
                            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
                        })}\n\n`);
                    }
                    res.write(`data: ${JSON.stringify({
                        id, object: 'chat.completion.chunk',
                        created, model: 'deepseek-web-v3',
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                    })}\n\ndata: [DONE]\n\n`);
                }
                res.end();
                console.log(`${agentTag} Streamed (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (toolCall) {
                    res.end(JSON.stringify(buildToolCallResponse(toolCall)));
                } else {
                    res.end(JSON.stringify(buildTextResponse(fullContent, fullPrompt)));
                }
                console.log(`${agentTag} Response (tool=${!!toolCall}, ${elapsed}ms, ${fullContent.length} chars)`);
            }
        } catch (e) {
            console.log('[DS-API] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        }
    });
});

const PORT = 9655;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DS-API] Server on http://0.0.0.0:${PORT} (multi-agent sessions enabled)`);
    console.log(`[DS-API] POST /v1/chat/completions (stream=true|false)`);
    console.log(`[DS-API] GET  /v1/sessions — list active agent sessions`);
    console.log(`[DS-API] POST /reset-session?agent=<id> — reset agent's session`);
    console.log(`[DS-API] POST /reset-session?agent=all — reset ALL sessions`);
});
