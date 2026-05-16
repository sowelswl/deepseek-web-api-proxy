# DeepSeek Web API Proxy

An **OpenAI-compatible API server** that wraps DeepSeek's free web chat interface (`chat.deepseek.com`), exposing it as a standard OpenAI `/v1/chat/completions` endpoint. Supports **streaming**, **tool calling**, **multi-session isolation**, and **automatic retry with fresh sessions**.

> ⚠️ **Not official.** This is a reverse-engineered integration of DeepSeek's web app network protocol. May break if DeepSeek changes their API.

---

## Features

- ✅ **OpenAI-compatible** — drop-in replacement for `https://api.openai.com/v1`
- ✅ **Streaming & non-streaming** — SSE streaming or standard JSON response
- ✅ **Tool calling** — inject tool definitions as text instructions, parse `TOOL_CALL:` responses
- ✅ **Multi-agent sessions** — per-user/agent session isolation with DeepSeek web sessions
- ✅ **Auto session recovery** — stale sessions reset automatically; retry loop with fresh sessions
- ✅ **Conversation history** — preserves last 5 exchanges for context recovery
- ✅ **Zero dependencies** — pure Node.js with `http`, `fs`, `os` (no npm packages needed)
- ✅ **Cross-platform** — Linux, macOS, Windows (Node.js 18+)

---

## Quick Start

```bash
# 1. Clone & enter
git clone https://github.com/tajerek/deepseek-web-api-proxy.git
cd deepseek-web-api-proxy

# 2. Configure your DeepSeek session
cp auth.example.json auth.json
# Edit auth.json with your credentials (see "Getting Credentials" below)

# 3. Start the proxy
node server.js
# Listening on http://0.0.0.0:9654
```

### Test it

```bash
# Health check
curl http://localhost:9654/

# List models
curl http://localhost:9654/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:9654/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web-v3",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Chat completion (streaming)
curl -X POST http://localhost:9654/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web-v3",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'

# List active sessions
curl http://localhost:9654/v1/sessions
```

---

## Getting Credentials

To use this proxy, you need authentication tokens from the DeepSeek website:

1. **Open** [chat.deepseek.com](https://chat.deepseek.com) in your browser
2. **Open DevTools** (F12) → Network tab
3. **Send any message** in the chat
4. **Find a request** to `chat.deepseek.com/api/v0/chat/completion`
5. **Copy these headers:**

| Header / Field | Where to find it |
|---|---|
| `Authorization` (token) | Request headers → `Authorization: Bearer <token>` |
| `x-hif-dliq` | Request headers |
| `x-hif-leim` | Request headers |
| `Cookie` | Request headers (needs `ds_session_id` and `smidV2`) |
| `wasmUrl` | Find `sha3_wasm_bg.*.wasm` in the page sources |

6. **Paste** into `auth.json`:

```json
{
  "token": "YOUR_TOKEN",
  "hif_dliq": "YOUR_HIF_DLIQ",
  "hif_leim": "YOUR_HIF_LEIM",
  "cookie": "ds_session_id=YOUR_SESSION; smidV2=YOUR_SMIDV2",
  "wasmUrl": "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.xxx.wasm"
}
```

> **Note:** These credentials expire periodically (typically 1–2 hours). When the proxy returns empty responses, reconnect to DeepSeek in your browser and refresh the values.

---

## API Reference

### `GET /`

Health check.

```json
{"status": "ok", "model": "deepseek-web-v3", "agents": 0}
```

### `GET /v1/models`

Returns available models.

```json
{"data": [{"id": "deepseek-web-v3", "object": "model", "created": ..., "owned_by": "deepseek-web"}]}
```

### `POST /v1/chat/completions`

OpenAI-compatible chat completion. Supports both `stream: true` (SSE) and `stream: false`.

**Request body:**

```json
{
  "model": "deepseek-web-v3",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false,
  "user": "my-agent-id"
}
```

**`user` field** — used for session isolation. Different values get separate DeepSeek sessions. When omitted, defaults to the requesting IP address. On localhost, defaults to `default`.

**Tool calling** — pass a `tools` array (OpenAI format). The proxy injects tool definitions into the system prompt and parses `TOOL_CALL:` responses from the model.

### `GET /v1/sessions`

List all active sessions with their message counts and ages.

### `POST /reset-session?agent=<id>`

Reset a specific agent's session. Use `?agent=all` to reset all sessions.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9654` | Server listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `AUTH_CONFIG_PATH` | `./auth.json` | Path to auth config file |

### Command-Line Client

The project includes a CLI client for quick testing:

```bash
node client.js "What is the capital of France?"
```

---

## Architecture

```
┌──────────────┐     POST /v1/chat/completions     ┌──────────────────┐
│              │ ──────────────────────────────►    │                  │
│   OpenAI     │    {messages, tools, stream}        │  DeepSeek Proxy  │
│   Client     │ ◄──────────────────────────────    │  (port 9654)     │
│              │    {choices[].message.content}      │  Node.js HTTP    │
└──────────────┘     or tool_calls response          │  Server          │
                                                     └────────┬─────────┘
                                                              │
                                    ┌─────────────────────────┼──────────────┐
                                    │                         │              │
                                    ▼                         ▼              ▼
                          ┌──────────────────┐    ┌──────────────────┐
                          │  PoW Challenge   │    │  Chat Completion │
                          │  /api/v0/chat/   │    │  /api/v0/chat/   │
                          │  create_pow_     │    │  completion      │
                          │  challenge       │    │                  │
                          └──────────────────┘    └──────────────────┘
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │  DeepSeek Web    │
                                               │  chat.deepseek   │
                                               │  .com            │
                                               │  (Free V3 model) │
                                               └──────────────────┘
```

### Request Flow

1. **Client** sends OpenAI-format request to proxy
2. **Proxy** extracts system prompt & tools, formats for DeepSeek
3. **Proxy** requests a Proof-of-Work challenge from DeepSeek
4. **Proxy** solves PoW using WebAssembly
5. **Proxy** creates or reuses a DeepSeek chat session
6. **Proxy** sends completion request with PoW proof
7. **Proxy** parses SSE stream from DeepSeek
8. **Proxy** converts to OpenAI format response
9. **Client** receives standard OpenAI response

---

## Session Management

The proxy maintains per-agent session state:

| Setting | Value |
|---|---|
| Max messages before auto-reset | 100 |
| Session TTL | 2 hours |
| History buffer (exchanges) | 5 |
| Empty response retries | 10 (with exponential backoff) |

When a session is reset (stale or full), the last 5 exchanges are preserved and re-injected as context for the new session.

---

## Tool Calling

The proxy supports OpenAI-style tool/function calling:

1. Client sends `tools` array in the request
2. Proxy injects tool definitions into the system prompt as structured text
3. Model responds with `TOOL_CALL: function_name` + `arguments: {...}`
4. Proxy parses the response and returns it as OpenAI `tool_calls` format
5. Client executes the tool and sends the result back in a follow-up message

---

## Use with Hermes Agents

To use this proxy with [Hermes Agent](https://hermes-agent.nousresearch.com/):

```yaml
# config.yaml
model:
  default: deepseek-web-v3
  provider: custom
  base_url: http://localhost:9654/v1
  model: deepseek-web-v3
```

---

## License

MIT
