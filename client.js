#!/usr/bin/env node
/**
 * DeepSeek Web API CLI Client
 * 
 * Usage: node client.js "your prompt here"
 *        node client.js < input.txt
 * 
 * Environment variables:
 *   DEEPSEEK_TOKEN        - Auth token (required)
 *   DEEPSEEK_HIF_DLIQ     - x-hif-dliq header
 *   DEEPSEEK_HIF_LEIM     - x-hif-leim header
 *   DEEPSEEK_COOKIE       - Cookie string
 *   DEEPSEEK_WASM_URL     - WASM solver URL
 */

const fs = require('fs');
const path = require('path');

// Load from env or config file
const CONFIG = {
    token: process.env.DEEPSEEK_TOKEN || '',
    hif_dliq: process.env.DEEPSEEK_HIF_DLIQ || '',
    hif_leim: process.env.DEEPSEEK_HIF_LEIM || '',
    cookie: process.env.DEEPSEEK_COOKIE || '',
    wasmUrl: process.env.DEEPSEEK_WASM_URL || 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
};

// Try loading from auth.json
try {
    const authPath = path.join(__dirname, 'auth.json');
    if (fs.existsSync(authPath) && !CONFIG.token) {
        const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        CONFIG.token = CONFIG.token || auth.token;
        CONFIG.hif_dliq = CONFIG.hif_dliq || auth.hif_dliq;
        CONFIG.hif_leim = CONFIG.hif_leim || auth.hif_leim;
        CONFIG.cookie = CONFIG.cookie || auth.cookie;
        CONFIG.wasmUrl = CONFIG.wasmUrl || auth.wasmUrl;
    }
} catch (e) {}

if (!CONFIG.token) {
    console.error('Error: DEEPSEEK_TOKEN not set. Provide via env or auth.json');
    console.error('Usage: DEEPSEEK_TOKEN=xxx node client.js "prompt"');
    process.exit(1);
}

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    'X-Client-Platform': 'web', 'X-Client-Version': '1.0.0-always',
    'X-Client-Locale': 'en_US', 'X-App-Version': '20241129.1',
    'Authorization': `Bearer ${CONFIG.token}`,
    'x-hif-dliq': CONFIG.hif_dliq, 'x-hif-leim': CONFIG.hif_leim,
    'Origin': 'https://chat.deepseek.com', 'Referer': 'https://chat.deepseek.com/',
    'Cookie': CONFIG.cookie, 'Content-Type': 'application/json',
};

async function solvePOW(challenge) {
    const resp = await fetch(CONFIG.wasmUrl);
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
    if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error('POW solve failed');
    return Math.floor(ans);
}

async function askDeepSeek(prompt, onChunk) {
    const chalResp = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
        method: 'POST', headers: BASE_HEADERS,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion', scene: 'completion_like' })
    });
    const chalData = await chalResp.json();
    const challenge = chalData.data.biz_data.challenge;
    const answer = await solvePOW(challenge);

    const sessResp = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
        method: 'POST', headers: BASE_HEADERS, body: '{}'
    });
    const sessData = await sessResp.json();
    const sessionId = sessData.data.biz_data.id;

    const powResp = {
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer, signature: challenge.signature,
        target_path: '/api/v0/chat/completion'
    };
    const powB64 = Buffer.from(JSON.stringify(powResp)).toString('base64');

    const compResp = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...BASE_HEADERS, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify({
            chat_session_id: sessionId,
            parent_message_id: null,
            model_type: 'default',
            prompt, ref_file_ids: [],
            thinking_enabled: false, search_enabled: false, user_options: {},
        })
    });

    const reader = compResp.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let lastPath = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6);
                if (!jsonStr) continue;
                try {
                    const data = JSON.parse(jsonStr);
                    if (data.p !== undefined) lastPath = data.p;
                    if (lastPath === 'response/content' && data.v) {
                        if (onChunk) onChunk(data.v);
                        fullResponse += data.v;
                    }
                } catch (e) {}
            }
        }
    }
    return fullResponse;
}

async function main() {
    const prompt = process.argv.slice(2).join(' ') || fs.readFileSync('/dev/stdin', 'utf8').trim();
    if (!prompt) {
        console.error('Usage: node client.js "your prompt here"');
        process.exit(1);
    }

    let fullText = '';
    const response = await askDeepSeek(prompt, (chunk) => {
        process.stdout.write(chunk);
        fullText += chunk;
    });
    process.stdout.write('\n');

    const ts = Date.now();
    fs.writeFileSync(`/tmp/deepseek_response_${ts}.txt`, fullText.trim());
    console.error(`\n[*] Saved /tmp/deepseek_response_${ts}.txt`);
}

main().catch(e => {
    console.error(`\n[!] Error: ${e.message}`);
    process.exit(1);
});
