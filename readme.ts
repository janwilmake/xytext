// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

/**
 * Collaborative Text Editor with X OAuth Authentication
 * - Durable objects based on path segments
 * - X OAuth for write permissions
 * - SQLite storage for persistence
 * - Real-time markdown preview
 *
 * https://lmpify.com/httpsuithubcomj-niymxy0
 */

interface Env {
  TEXT: DurableObjectNamespace;
  KV: KVNamespace;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_REDIRECT_URI: string;
  ENVIRONMENT: string;
}

interface Session {
  webSocket: WebSocket;
  username: string;
  isAdmin: boolean;
}

interface WSMessage {
  type: string;
  text?: string;
  version?: number;
  sessionId?: string;
  sessionCount?: number;
  isAdmin?: boolean;
  username?: string;
  fromSession?: string;
}

export class TextDO implements DurableObject {
  private sessions: Map<string, Session> = new Map();
  private textContent: string = "";
  private version: number = 0;
  private sql: SqlStorage;

  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.initSQLite();
  }

  async initSQLite(): Promise<void> {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        path TEXT PRIMARY KEY,
        content TEXT,
        created_at INTEGER,
        updated_at INTEGER
      )
    `);

    // Load existing content
    const result = this.sql.exec(
      `SELECT content FROM documents WHERE path = ?`,
      [this.state.id.toString()],
    );

    console.log({ result });
    if (result.toArray().length > 0) {
      this.textContent = (result.toArray()[0].content as string) || "";
    }
  }

  saveContent(content: string) {
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO documents (path, content, created_at, updated_at)
       VALUES (?, ?, COALESCE((SELECT created_at FROM documents WHERE path = ?), ?), ?)`,
      this.state.id.toString(),
      content,
      this.state.id.toString(),
      now,
      now,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      const sessionId = crypto.randomUUID();
      const usernameStr = url.searchParams.get("username") || "anonymous";
      const isAdmin =
        usernameStr === "admin" ||
        url.searchParams.get("path").startsWith("/" + usernameStr + "/") ||
        url.searchParams.get("path").startsWith("/anonymous/");

      this.sessions.set(sessionId, {
        webSocket: server,
        username: usernameStr,
        isAdmin,
      });

      server.send(
        JSON.stringify({
          type: "init",
          sessionId,
          text: this.textContent,
          version: this.version,
          sessionCount: this.sessions.size,
          isAdmin,
          username: usernameStr,
        } as WSMessage),
      );

      server.addEventListener("message", async (msg: MessageEvent) => {
        try {
          const data = JSON.parse(msg.data as string) as WSMessage;

          console.log({ data });
          if (
            data.type === "text" &&
            isAdmin &&
            data.text !== undefined &&
            data.version !== undefined
          ) {
            this.textContent = data.text;
            this.version = data.version;
            await this.saveContent(data.text);
            this.broadcast(sessionId, {
              type: "text",
              text: data.text,
              version: data.version,
              fromSession: sessionId,
            });
          }
        } catch (err) {
          console.error("Error:", err);
        }
      });

      server.addEventListener("close", () => {
        this.sessions.delete(sessionId);
        this.broadcast(sessionId, {
          type: "leave",
          sessionId,
          sessionCount: this.sessions.size,
        });
      });

      this.broadcast(sessionId, {
        type: "join",
        sessionId,
        sessionCount: this.sessions.size,
      });

      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  broadcast(senderSessionId: string, message: WSMessage): void {
    const messageStr = JSON.stringify(message);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId !== senderSessionId) {
        try {
          session.webSocket.send(messageStr);
        } catch (err) {
          this.sessions.delete(sessionId);
        }
      }
    }
  }
}

async function generateRandomString(length: number): Promise<string> {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface UserResponse {
  data: {
    username: string;
    id: string;
    name: string;
  };
}

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = env.ENVIRONMENT === "development";

    // OAuth middleware
    if (!isLocalhost) {
      if (url.pathname === "/logout") {
        const redirectTo = url.searchParams.get("redirect_to") || "/";
        return new Response(null, {
          status: 302,
          headers: {
            Location: redirectTo,
            "Set-Cookie":
              "x_access_token=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
          },
        });
      }

      if (url.pathname === "/login") {
        const state = await generateRandomString(16);
        const codeVerifier = await generateRandomString(43);
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        const headers = new Headers({
          Location: `https://x.com/i/oauth2/authorize?response_type=code&client_id=${
            env.X_CLIENT_ID
          }&redirect_uri=${encodeURIComponent(
            env.X_REDIRECT_URI,
          )}&scope=${encodeURIComponent(
            "users.read tweet.read offline.access",
          )}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
        });

        headers.append(
          "Set-Cookie",
          `x_oauth_state=${state}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=600`,
        );
        headers.append(
          "Set-Cookie",
          `x_code_verifier=${codeVerifier}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=600`,
        );

        return new Response("Redirecting", { status: 307, headers });
      }

      if (url.pathname === "/callback") {
        const urlState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const cookie = request.headers.get("Cookie") || "";
        const cookies = cookie.split(";").map((c) => c.trim());

        const stateCookie = cookies
          .find((c) => c.startsWith("x_oauth_state="))
          ?.split("=")[1];
        const codeVerifier = cookies
          .find((c) => c.startsWith("x_code_verifier="))
          ?.split("=")[1];

        if (
          !urlState ||
          !stateCookie ||
          urlState !== stateCookie ||
          !codeVerifier
        ) {
          return new Response("Invalid state or missing code verifier", {
            status: 400,
          });
        }

        try {
          const tokenResponse = await fetch(
            "https://api.twitter.com/2/oauth2/token",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${btoa(
                  `${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`,
                )}`,
              },
              body: new URLSearchParams({
                code: code || "",
                redirect_uri: env.X_REDIRECT_URI,
                grant_type: "authorization_code",
                code_verifier: codeVerifier,
              }),
            },
          );

          if (!tokenResponse.ok) {
            throw new Error(
              `Twitter API responded with ${tokenResponse.status}`,
            );
          }

          const { access_token }: TokenResponse = await tokenResponse.json();
          let username = `username_${await generateRandomString(7)}`;

          try {
            const userResponse = await fetch("https://api.x.com/2/users/me", {
              headers: { Authorization: `Bearer ${access_token}` },
            });
            if (userResponse.ok) {
              const { data }: UserResponse = await userResponse.json();
              username = data.username;
            }
          } catch (err) {
            console.error("Failed to fetch user info:", err);
          }

          await env.KV.put(`token:${access_token}`, username);

          const headers = new Headers({
            Location: url.searchParams.get("redirect") || "/",
          });

          headers.append(
            "Set-Cookie",
            `x_access_token=${encodeURIComponent(
              access_token,
            )}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=34560000`,
          );
          headers.append("Set-Cookie", `x_oauth_state=; Max-Age=0`);
          headers.append("Set-Cookie", `x_code_verifier=; Max-Age=0`);

          return new Response("Redirecting", { status: 307, headers });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          return new Response(`Login failed: ${errorMessage}`, {
            status: 500,
          });
        }
      }
    }

    // WebSocket endpoint
    if (url.pathname === "/ws") {
      const path = url.searchParams.get("path") || "/default";

      let username = "admin";
      if (!isLocalhost) {
        const token = request.headers
          .get("Cookie")
          ?.split(";")
          .find((r) => r.includes("x_access_token"))
          ?.split("=")[1];
        if (token) {
          username =
            (await env.KV.get(`token:${decodeURIComponent(token)}`)) ||
            "anonymous";
        } else {
          username = "anonymous";
        }
      }

      const usernameFromPath = path.split("/")[1];
      const roomObject = env.TEXT.get(env.TEXT.idFromName(usernameFromPath));
      const newUrl = new URL(url);
      newUrl.pathname = "/ws";
      newUrl.searchParams.set("username", username);
      newUrl.searchParams.set("path", path);
      return roomObject.fetch(new Request(newUrl, request));
    }

    // Serve the HTML interface
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html;charset=utf8" },
    });
  },
};

export default worker;

const HTML_CONTENT = `<!DOCTYPE html>
<html>
<head>
<title>Collaborative Text Editor</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f5f5f5; font-family: Arial, sans-serif; }
header { background: white; padding: 15px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
.header-content { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 15px; }
.header-left { display: flex; flex-direction: column; }
.header-center { display: flex; align-items: center; gap: 10px; }
.header-right { display: flex; align-items: center; gap: 15px; }
#status { color: #666; font-size: 14px; margin-top: 5px; }
.container { display: flex; height: calc(100vh - 100px); }
.panel { flex: 1; padding: 20px; }
#editor { width: 100%; height: 100%; padding: 15px; border: 2px solid #ddd; border-radius: 8px; font-family: Monaco, Courier, monospace; font-size: 14px; resize: none; background: white; }
#editor:focus { border-color: #007bff; outline: none; }
#preview { background: white; border: 2px solid #ddd; border-radius: 8px; padding: 15px; height: 100%; overflow-y: auto; }
.btn { background: #007bff; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; border: none; cursor: pointer; font-size: 14px; }
.btn:hover { background: #0056b3; }
.room-form { display: flex; align-items: center; gap: 8px; }
.room-form input[type="text"] { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
.room-form input[type="checkbox"] { margin-right: 5px; }
.room-form label { font-size: 14px; color: #666; }
.connection-info { font-size: 14px; color: #666; }
@media (max-width: 768px) {
  .container { flex-direction: column; }
  .header-content { flex-direction: column; align-items: stretch; }
  .admin-only { display: block; }
  .readonly-only { display: none; }
}
@media (min-width: 769px) {
  .admin-only { display: block; }
  .readonly-only { display: block; }
}
.readonly .admin-only { display: none; }
.readonly .readonly-only { display: block; }
</style>
</head>
<body>
<header>
  <div class="header-content">
    <div class="header-left">
      <h1 style="margin: 0;">Collaborative Editor</h1>
      <div id="status">Connecting...</div>
    </div>
    <div class="header-center">
      <form class="room-form" id="roomForm">
        <input type="text" id="roomInput" placeholder="Room name" value="">
        <label><input type="checkbox" id="anonymousCheck"> Anonymous</label>
        <button type="submit" class="btn">Join Room</button>
      </form>
    </div>
    <div class="header-right">
      <div class="connection-info" id="connectionInfo"></div>
      <div id="authSection"></div>
    </div>
  </div>
</header>
<div class="container" id="container">
  <div class="panel admin-only">
    <textarea id="editor" placeholder="Start typing... changes sync in real-time"></textarea>
  </div>
  <div class="panel">
    <div id="preview"></div>
  </div>
</div>
<script>
class TextApp {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.version = 0;
    this.sessionCount = 0;
    this.isAdmin = false;
    this.username = null;
    this.statusEl = document.getElementById('status');
    this.connectionInfoEl = document.getElementById('connectionInfo');
    this.editorEl = document.getElementById('editor');
    this.previewEl = document.getElementById('preview');
    this.containerEl = document.getElementById('container');
    this.authEl = document.getElementById('authSection');
    this.roomFormEl = document.getElementById('roomForm');
    this.roomInputEl = document.getElementById('roomInput');
    this.anonymousCheckEl = document.getElementById('anonymousCheck');
    this.isUpdating = false;
    this.currentPath = window.location.pathname || '/default';
    this.isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    this.setupAuth();
    this.setupRoomForm();
    this.connect();
    this.setupEventListeners();
  }
  
  setupAuth() {
    const token = document.cookie.split(';').find(c => c.trim().startsWith('x_access_token='));
    
    if (this.isLocalhost) {
      this.authEl.innerHTML = '<span style="color: #666;">Localhost Mode</span>';
    } else if (token) {
      this.authEl.innerHTML = '<a href="/logout" class="btn">Logout</a>';
    } else {
      this.authEl.innerHTML = '<a href="/login" class="btn">Login with X</a>';
    }
  }

  setupRoomForm() {
    // Extract current room from path
    const pathParts = this.currentPath.split('/').filter(p => p);
    if (pathParts.length > 0) {
      this.roomInputEl.value = pathParts[pathParts.length - 1];
    }

    this.roomFormEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const roomName = this.roomInputEl.value.trim();
      if (!roomName) return;

      let newPath;
      if (this.anonymousCheckEl.checked) {
        newPath = '/anonymous/' + encodeURIComponent(roomName);
      } else {
        newPath = '/' + (this.username || 'default') + '/' + encodeURIComponent(roomName);
      }
      
      window.location.href = newPath;
    });
  }
  
  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + '/ws?path=' + encodeURIComponent(this.currentPath);
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      this.statusEl.textContent = 'Connected';
      this.statusEl.style.color = '#28a745';
    };
    
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };
    
    this.ws.onclose = () => {
      this.statusEl.textContent = 'Disconnected. Reconnecting...';
      this.statusEl.style.color = '#dc3545';
      setTimeout(() => this.connect(), 1000);
    };
  }
  
  handleMessage(message) {
    switch (message.type) {
      case 'init':
        this.sessionId = message.sessionId;
        this.version = message.version;
        this.sessionCount = message.sessionCount;
        this.isAdmin = message.isAdmin;
        this.username = message.username;
        
        this.statusEl.textContent = \`Connected - \${this.isAdmin ? 'Editor' : 'Read-only'}\`;
        
        this.isUpdating = true;
        const cursorPos = this.editorEl.selectionStart;
        this.editorEl.value = message.text;
        this.updatePreview(message.text);
        if (this.isAdmin) {
          this.editorEl.setSelectionRange(cursorPos, cursorPos);
        }
        this.isUpdating = false;
        
        // Set readonly state
        if (!this.isAdmin) {
          this.containerEl.classList.add('readonly');
          this.editorEl.disabled = true;
        }
        
        this.updateConnectionInfo();
        break;
        
      case 'text':
        if (message.fromSession !== this.sessionId) {
          this.isUpdating = true;
          const cursorPos = this.editorEl.selectionStart;
          this.editorEl.value = message.text;
          this.updatePreview(message.text);
          this.version = message.version;
          if (this.isAdmin) {
            this.editorEl.setSelectionRange(cursorPos, cursorPos);
          }
          this.isUpdating = false;
        }
        break;
        
      case 'join':
      case 'leave':
        this.sessionCount = message.sessionCount;
        this.updateConnectionInfo();
        break;
    }
  }
  
  updatePreview(text) {
    this.previewEl.innerHTML = marked.parse(text || '# Welcome\\n\\nStart typing in the editor to see your markdown rendered here.');
  }
  
  updateConnectionInfo() {
    this.connectionInfoEl.innerHTML = 
      '<div><strong>' + (this.username || 'connecting...') + '</strong> • ' +
      (this.isAdmin ? 'Editor' : 'Read-only') + ' • ' +
      this.sessionCount + ' user' + (this.sessionCount !== 1 ? 's' : '') + ' • ' +
      'v' + this.version + '</div>';
  }
  
  setupEventListeners() {
    let lastSendTime = 0;
    const throttleDelay = 200;
    
    const sendText = () => {
      const now = Date.now();
      if (!this.isUpdating && now - lastSendTime > throttleDelay && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.version++;
        this.ws.send(JSON.stringify({ 
          type: 'text', 
          text: this.editorEl.value,
          version: this.version
        }));
        this.updatePreview(this.editorEl.value);
        lastSendTime = now;
        this.updateConnectionInfo();
      }
    };
    
    this.editorEl.addEventListener('input', sendText);
    this.editorEl.addEventListener('paste', () => {
      setTimeout(sendText, 10);
    });
  }
}

new TextApp();
</script>
</body>
</html>`;
