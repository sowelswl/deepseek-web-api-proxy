# DeepSeek Web API Proxy

An **OpenAI-compatible API server** that wraps DeepSeek's free web chat interface (`chat.deepseek.com`), exposing it as a standard OpenAI `/v1/chat/completions` endpoint. Supports **streaming**, **tool calling**, **multi-session isolation**, **auto-continuation for long responses**, **MEDIA file injection**, and **browser workflow** integration.

> ⚠️ **Not official.** This is a reverse-engineered integration of DeepSeek's web app network protocol. May break if DeepSeek changes their API.

---

## Features

- ✅ **OpenAI-compatible** — drop-in replacement for `https://api.openai.com/v1`
- ✅ **Streaming & non-streaming** — SSE streaming or standard JSON response
- ✅ **Tool calling** — inject tool definitions as text instructions, parse `TOOL_CALL:` responses
- ✅ **Multi-agent sessions** — per-user/agent session isolation with DeepSeek web sessions
- ✅ **Auto session recovery** — stale sessions reset automatically; retry loop with fresh sessions
- ✅ **Auto-continuation** — detects DeepSeek "Continue generating" pauses via 25s idle timeout, sends `continue` to fetch the rest (up to 4 continuation rounds)
- ✅ **MEDIA file injection** — auto-detects file paths in tool results and appends `MEDIA:/path/to/file` for Telegram attachment delivery
- ✅ **Browser workflow** — optimized prompts for `browser_navigate` → `browser_snapshot` → `browser_vision` sequence
- ✅ **Conversation history** — preserves last 15 exchanges for context recovery
- ✅ **Zero dependencies** — pure Node.js with `http`, `fs`, `os` (no npm packages needed)
- ✅ **Proof-of-Work solving** — automatically handles DeepSeek's PoW challenges via WebAssembly
- ✅ **systemd ready** — designed for deployment as a systemd service with auto-restart
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
# Listening on http://0.0.0.0:9655
```

### Test it

```bash
# Health check
curl http://localhost:9655/

# List models
curl http://localhost:9655/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web-v3",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Chat completion (streaming)
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web-v3",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'

# List active sessions
curl http://localhost:9655/v1/sessions
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
| `Authorization` (token) | Request headers → `Authorization: Bearer ***` |
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
  "wasmUrl": "https://fe-static.deepseek.com/static/sha3_wasm_bg.xxx.wasm"
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

**`user` field** — used for session isolation. Different values get separate DeepSeek sessions. When omitted, defaults to the requesting IP address. On localhost, defaults to `dev-agent`.

**Tool calling** — pass a `tools` array (OpenAI format). The proxy injects tool definitions into the system prompt and parses `TOOL_CALL:` responses from the model.

**MEDIA file injection** — when tool results contain file paths (screenshots, generated PDFs, etc.), the proxy auto-appends `MEDIA:/path/to/file` tags for Telegram attachment delivery.

### `GET /v1/sessions`

List all active sessions with their message counts and ages.

```json
{
  "agents": [
    {
      "agent": "dev-agent",
      "session_id": "abc123",
      "message_count": 5,
      "history_size": 3,
      "age_min": 12
    }
  ],
  "total": 1
}
```

### `POST /reset-session?agent=<id>`

Reset a specific agent's DeepSeek web session. Use `?agent=all` to reset all sessions. History is preserved and re-injected on the next request.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9655` | Server listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `AUTH_CONFIG_PATH` | `./auth.json` | Path to auth config file (currently hardcoded to `deepseek-auth.json`) |

### Systemd Service (Production)

For production deployments, run as a systemd service with auto-restart:

```ini
# /etc/systemd/system/deepseek-web-proxy.service
[Unit]
Description=DeepSeek Web API Proxy
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/deepseek-web-api-proxy
ExecStart=/usr/bin/node /root/deepseek-web-api-proxy/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable deepseek-web-proxy.service
systemctl start deepseek-web-proxy.service
```

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
│   Client     │ ◄──────────────────────────────    │  (port 9655)     │
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
                                               │  (Free model)    │
                                               └──────────────────┘
```

### Request Flow

1. **Client** sends OpenAI-format request to proxy
2. **Proxy** extracts system prompt & tools, formats for DeepSeek
3. **Proxy** requests a Proof-of-Work challenge from DeepSeek
4. **Proxy** solves PoW using WebAssembly
5. **Proxy** creates or reuses a DeepSeek chat session
6. **Proxy** sends completion request with PoW proof
7. **Proxy** parses SSE stream from DeepSeek (with 25s idle timeout for "Continue" pauses)
8. **Proxy** auto-continues long responses (up to 4 rounds)
9. **Proxy** checks tool results for file paths, injects MEDIA: tags
10. **Proxy** converts to OpenAI format response
11. **Client** receives standard OpenAI response

---

## Session Management

The proxy maintains per-agent session state:

| Setting | Value |
|---|---|
| Max messages before auto-reset | 100 |
| Session TTL | 2 hours |
| History buffer (exchanges) | 15 |
| Max history chars | 10,000 |
| Empty response retries | 3 (with backoff) |
| Auto-continuation rounds | 4 |
| Stream idle timeout | 25 seconds |

When a session is reset (stale or full), the last 15 exchanges are preserved and re-injected as context for the new session.

---

## Tool Calling

The proxy supports OpenAI-style tool/function calling:

1. Client sends `tools` array in the request
2. Proxy injects tool definitions into the system prompt as structured text
3. Model responds with `TOOL_CALL: function_name` + `arguments: {...}`
4. Proxy parses the response and returns it as OpenAI `tool_calls` format
5. Client executes the tool and sends the result back in a follow-up message

### Browser Workflow

For web page interaction, the proxy recommends this sequence:
1. `browser_navigate(url: "https://...")` — go to a page
2. `browser_snapshot()` — wait for page load and get text content
3. `browser_vision(question: "describe what you see")` — take a screenshot and analyze

Screenshot paths are auto-detected and delivered via MEDIA: tags.

### File Detection

The proxy scans the last 3 tool results for file paths (`screenshot_path`, `path`, `file_path`, `output_path`, `result_path`). Real files are injected as `MEDIA:/path/to/file` into the response for automatic attachment delivery.

Supported extensions: `png|jpg|jpeg|webp|gif|pdf|docx|doc|txt|md|html|htm|xlsx|xls|csv|pptx|zip|tar|gz|mp4|mov|mp3|wav|ogg`

---

## Use with Hermes Agents

To use this proxy with [Hermes Agent](https://hermes-agent.nousresearch.com/):

```yaml
# config.yaml
model:
  default: deepseek-web-v3
  provider: custom
  base_url: http://localhost:9655/v1
  model: deepseek-web-v3
```

For Telegram integration, enable the `browser` toolset in your agent's config for web page interaction and screenshot capabilities.

---

## License

MIT
