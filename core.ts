// its intereating to think about; this kinda gives us a x-oauth-provided DO per user with nice exploration-efficient datastructure inside and a realtime way to connect with this data files.
//
// this is pretty cool, as it would allow anyone to make tools for this fs. e.g. a terminal!
//
// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";
import { DurableObject } from "cloudflare:workers";
import {
  AuthProvider,
  oauthEndpoints,
} from "https://uithub.com/janwilmake/simplerauth-provider/blob/main/provider.ts";

interface Env {
  TEXT: DurableObjectNamespace<TextDO & QueryableHandler>;
  AuthProvider: DurableObjectNamespace<AuthProvider>;
  KV: KVNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  ENVIRONMENT: string;
}

interface Session {
  webSocket: WebSocket;
  path: string;
  username: string;
}

interface WSMessage {
  type: string;
  text?: string;
  version?: number;
  sessionId?: string;
  fromSession?: string;
}

interface User {
  x_user_id: string;
  username: string;
  name: string;
  profile_image_url: string;
  verified?: boolean;
}

@Queryable()
export class TextDO extends DurableObject {
  private sessions: Map<string, Session> = new Map();
  private version: number = 0;
  public sql: SqlStorage;
  public env: Env;

  constructor(private state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.env = env;
    this.initSQLite();
  }

  async initSQLite(): Promise<void> {
    // Main nodes table for file storage
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        parent_path TEXT,
        type TEXT CHECK(type IN ('file', 'folder')) NOT NULL,
        content TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Indexes for performance
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_parent_path ON nodes(parent_path)`
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_type ON nodes(type)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_path_type ON nodes(path, type)`
    );
  }

  // Helper to parse path components
  private parsePathComponents(path: string): {
    name: string;
    parent_path: string | null;
  } {
    if (path === "/") {
      return { name: "/", parent_path: null };
    }

    const parts = path.slice(1).split("/");
    if (parts.length === 1) {
      return { name: parts[0], parent_path: null };
    }

    const name = parts[parts.length - 1];
    const parent_path = "/" + parts.slice(0, -1).join("/");
    return { name, parent_path };
  }

  saveContent(path: string, content: string): void {
    const now = Math.round(Date.now() / 1000);
    const { name, parent_path } = this.parsePathComponents(path);

    this.sql.exec(
      `
      INSERT OR REPLACE INTO nodes (path, name, parent_path, type, content, created_at, updated_at)
      VALUES (?, ?, ?, 'file', ?, 
        COALESCE((SELECT created_at FROM nodes WHERE path = ?), ?), 
        ?)
    `,
      path,
      name,
      parent_path,
      content,
      path,
      now,
      now
    );
  }

  getContent(path: string): string | null {
    const result = this.sql
      .exec(`SELECT content FROM nodes WHERE path = ? AND type = 'file'`, path)
      .toArray()[0] as { content: string } | undefined;
    return result?.content || null;
  }

  async getUserFromToken(token: string): Promise<User | null> {
    if (!token) return null;

    // Get the provider stub to validate the token
    const providerStub = this.env.AuthProvider.get(
      this.env.AuthProvider.idFromName("provider")
    );

    // In a real implementation, you'd want to add a method to the provider
    // to validate tokens and return user info. For now, we'll use KV as fallback
    const user = await this.env.KV.get<User>(
      `v2:token:${decodeURIComponent(token)}`,
      "json"
    );
    return user;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter((p) => p);
    const firstSegment = pathSegments[0] || "default";

    const token = request.headers
      .get("Cookie")
      ?.split(";")
      .find((r) => r.includes("access_token"))
      ?.split("=")[1];

    const user = await this.getUserFromToken(token || "");
    const isAdmin = user && firstSegment === user.username;

    // Load file content
    let textContent = this.getContent(url.pathname) || "";

    // Create new file if admin visits non-existent path
    if (!textContent && isAdmin && url.pathname !== `/${firstSegment}`) {
      this.saveContent(url.pathname, "");
      textContent = "";
    }

    // WebSocket handling
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(
        request,
        user,
        isAdmin,
        textContent,
        url.pathname
      );
    }

    // Return raw content for non-HTML requests
    if (!request.headers.get("accept")?.includes("text/html")) {
      return new Response(textContent || "Not Found", {
        status: textContent ? 200 : 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Return simple HTML editor
    return new Response(
      this.renderEditor(user, url.pathname, textContent, isAdmin),
      {
        headers: { "content-type": "text/html;charset=utf8" },
      }
    );
  }

  handleWebSocket(
    request: Request,
    user: User | null,
    isAdmin: boolean,
    textContent: string,
    path: string
  ): Response {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    const sessionId = crypto.randomUUID();

    this.sessions.set(sessionId, {
      path,
      webSocket: server,
      username: user?.username || "anonymous",
    });

    server.addEventListener("close", () => {
      this.sessions.delete(sessionId);
    });

    server.send(
      JSON.stringify({
        type: "init",
        text: textContent,
        version: this.version,
        sessionId,
        isAdmin,
        username: user?.username || "anonymous",
      })
    );

    server.addEventListener("message", async (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data as string) as WSMessage;
        if (
          data.type === "text" &&
          isAdmin &&
          data.text !== undefined &&
          data.version !== undefined
        ) {
          this.version = data.version;
          this.saveContent(path, data.text);
          this.broadcast(
            sessionId,
            {
              type: "text",
              text: data.text,
              version: data.version,
              fromSession: sessionId,
            },
            path
          );
        }
      } catch (err) {
        console.error("Error:", err);
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  renderEditor(
    user: User | null,
    currentPath: string,
    textContent: string,
    isAdmin: boolean
  ): string {
    const displayName = user ? `${user.name} (@${user.username})` : "Anonymous";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Simple Text Editor - ${currentPath}</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding: 10px 0;
            border-bottom: 1px solid #ddd;
        }
        
        .editor {
            width: 100%;
            height: 70vh;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 15px;
            font-family: 'Monaco', 'Cascadia Code', monospace;
            font-size: 14px;
            resize: none;
            background: white;
        }
        
        .status {
            margin-top: 10px;
            padding: 5px 10px;
            background: #007bff;
            color: white;
            border-radius: 4px;
            display: inline-block;
            font-size: 12px;
        }
        
        .btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
        }
        
        .btn:hover {
            background: #0056b3;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${currentPath}</h1>
        <div>
            <span>User: ${displayName}</span>
            ${
              user
                ? '<a href="/logout" class="btn">Logout</a>'
                : '<a href="/login" class="btn">Login</a>'
            }
        </div>
    </div>
    
    <textarea id="editor" class="editor" placeholder="Start typing..." ${
      !isAdmin ? "readonly" : ""
    }>${textContent}</textarea>
    
    <div class="status" id="status">Connected</div>

    <script>
        const editor = document.getElementById('editor');
        const status = document.getElementById('status');
        let ws = null;
        let version = 0;
        let sessionId = null;
        const isAdmin = ${JSON.stringify(isAdmin)};
        
        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host + window.location.pathname;
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                status.textContent = 'Connected';
                status.style.background = '#28a745';
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                handleMessage(message);
            };
            
            ws.onclose = () => {
                status.textContent = 'Disconnected - Reconnecting...';
                status.style.background = '#dc3545';
                setTimeout(connect, 1000);
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }
        
        function handleMessage(message) {
            switch (message.type) {
                case 'init':
                    version = message.version;
                    sessionId = message.sessionId;
                    editor.value = message.text;
                    break;
                    
                case 'text':
                    if (message.fromSession !== sessionId) {
                        const cursorPosition = editor.selectionStart;
                        editor.value = message.text;
                        version = message.version;
                        editor.setSelectionRange(cursorPosition, cursorPosition);
                    }
                    break;
            }
        }
        
        function sendText() {
            if (!ws || ws.readyState !== WebSocket.OPEN || !isAdmin) return;
            
            version++;
            ws.send(JSON.stringify({
                type: 'text',
                text: editor.value,
                version: version
            }));
        }
        
        if (isAdmin) {
            editor.addEventListener('input', sendText);
        }
        
        connect();
    </script>
</body>
</html>`;
  }

  broadcast(senderSessionId: string, message: WSMessage, path?: string): void {
    const messageStr = JSON.stringify(message);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId !== senderSessionId) {
        if (!path || session.path === path) {
          try {
            session.webSocket.send(messageStr);
          } catch (err) {
            this.sessions.delete(sessionId);
          }
        }
      }
    }
  }
}

const getLoggedStub = async (request: Request, env: Env) => {
  const token =
    request.headers
      .get("Cookie")
      ?.split(";")
      .find((r) => r.includes("access_token"))
      ?.split("=")[1] ||
    request.headers.get("Authorization")?.slice("Bearer ".length);

  if (!token) return null;

  const user = await env.KV.get<User>(
    `v2:token:${decodeURIComponent(token)}`,
    "json"
  );
  if (!user) return null;

  const stub = env.TEXT.get(env.TEXT.idFromName(user.username + ":v1"));
  return stub;
};

const getLoggedUser = async (
  request: Request,
  env: Env
): Promise<User | null> => {
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .find((r) => r.includes("access_token"))
    ?.split("=")[1];

  if (!token) return null;

  return await env.KV.get<User>(
    `v2:token:${decodeURIComponent(token)}`,
    "json"
  );
};

export { AuthProvider };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle OAuth endpoints through the provider
    if (oauthEndpoints.includes(url.pathname)) {
      const providerStub = env.AuthProvider.get(
        env.AuthProvider.idFromName("provider")
      );
      return providerStub.fetch(request);
    }

    // Handle logout
    if (url.pathname === "/logout") {
      const isLocalhost = env.ENVIRONMENT === "development";
      const securePart = isLocalhost ? "" : " Secure;";
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `access_token=; HttpOnly;${securePart} SameSite=Lax; Max-Age=0; Path=/`,
        },
      });
    }

    // Handle login redirect
    if (url.pathname === "/login") {
      const clientId = url.hostname;
      const redirectUri = `${url.origin}/auth-callback`;
      const authUrl = new URL(`${url.origin}/authorize`);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("state", crypto.randomUUID());

      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl.toString(),
        },
      });
    }

    // Handle auth callback
    if (url.pathname === "/auth-callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code) {
        return new Response("Authorization failed", { status: 400 });
      }

      // Exchange code for token
      const tokenUrl = new URL(`${url.origin}/token`);
      const tokenResponse = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: url.hostname,
        }),
      });

      if (!tokenResponse.ok) {
        return new Response("Failed to exchange token", { status: 400 });
      }

      const { access_token } = await tokenResponse.json<{
        access_token: string;
      }>();

      // Get user info using the access token (you'll need to add this method to your provider)
      // For now, we'll assume the token contains user info or we store it during the OAuth process

      const isLocalhost = env.ENVIRONMENT === "development";
      const securePart = isLocalhost ? "" : " Secure;";

      return new Response(null, {
        status: 302,
        headers: {
          Location: "/", // Will redirect to username after cookie is set
          "Set-Cookie": `access_token=${encodeURIComponent(
            access_token
          )}; HttpOnly; Path=/;${securePart} SameSite=Lax; Max-Age=34560000`,
        },
      });
    }

    // Studio endpoint
    if (url.pathname === "/studio") {
      const stub = await getLoggedStub(request, env);
      if (!stub) {
        return new Response("Unauthorized", { status: 401 });
      }
      return studioMiddleware(request, stub.raw, {
        dangerouslyDisableAuth: true,
      });
    }

    // Exec API endpoint
    if (url.pathname === "/exec") {
      const stub = await getLoggedStub(request, env);
      if (!stub) {
        return new Response("Unauthorized", { status: 401 });
      }
      const query = url.searchParams.get("query");
      const bindings = url.searchParams.getAll("binding");
      const result = await stub.exec(query, ...bindings);
      return new Response(JSON.stringify(result, undefined, 2), {
        headers: { "content-type": "application/json;charset=utf8" },
      });
    }

    // Root path handling - redirect based on auth status
    if (url.pathname === "/") {
      const user = await getLoggedUser(request, env);

      if (!user) {
        // Not logged in, redirect to login
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/login",
          },
        });
      } else {
        // Logged in, redirect to user's page
        return new Response(null, {
          status: 302,
          headers: {
            Location: `/${user.username}`,
          },
        });
      }
    }

    // Route to appropriate user's Durable Object
    const username = url.pathname.split("/")[1] || "default";
    const stub = env.TEXT.get(env.TEXT.idFromName(username + ":v1"));
    return stub.fetch(request);
  },
};
