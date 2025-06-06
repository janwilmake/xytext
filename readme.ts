// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

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
  path: string;
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
  //@ts-ignore
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class TextDO implements DurableObject {
  private sessions: Map<string, Session> = new Map();
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
  }

  saveContent(path: string, content: string) {
    const now = Date.now();
    const updated = this.sql.exec(
      `INSERT OR REPLACE INTO documents (path, content, created_at, updated_at)
       VALUES (?, ?, COALESCE((SELECT created_at FROM documents WHERE path = ?), ?), ?)`,
      path,
      content,
      path,
      now,
      now,
    );

    console.log("savecontent", updated.rowsRead, updated.rowsWritten);
  }

  async getUsernameFromToken(token: string): Promise<string> {
    if (!token) return "anonymous";
    const username = await this.env.KV.get(
      `token:${decodeURIComponent(token)}`,
    );
    return username || "anonymous";
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = this.env.ENVIRONMENT === "development";

    // Load existing content
    const textContent =
      this.sql
        .exec(`SELECT content FROM documents WHERE path = ?`, url.pathname)
        .toArray()[0]?.content || "";

    // WebSocket handling
    if (request.headers.get("Upgrade") === "websocket") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      const sessionId = crypto.randomUUID();

      let username = "admin";
      if (!isLocalhost) {
        const token = request.headers
          .get("Cookie")
          ?.split(";")
          .find((r) => r.includes("x_access_token"))
          ?.split("=")[1];
        username = await this.getUsernameFromToken(token || "");
      }

      const pathSegments = url.pathname.split("/").filter((p) => p);
      const firstSegment = pathSegments[0] || "default";

      const isAdmin =
        username === "admin" ||
        firstSegment === username ||
        firstSegment === "anonymous";

      this.sessions.set(sessionId, {
        path: url.pathname,
        webSocket: server,
        username,
        isAdmin,
      });

      server.send(
        JSON.stringify({
          type: "init",
          sessionId,
          text: textContent,
          version: this.version,
          sessionCount: this.sessions.size,
          isAdmin,
          username,
        } as WSMessage),
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
            this.saveContent(url.pathname, data.text);
            this.broadcast(url.pathname, sessionId, {
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
        this.broadcast(url.pathname, sessionId, {
          type: "leave",
          sessionId,
          sessionCount: this.sessions.size,
        });
      });

      this.broadcast(url.pathname, sessionId, {
        type: "join",
        sessionId,
        sessionCount: this.sessions.size,
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // OAuth endpoints
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
          this.env.X_CLIENT_ID
        }&redirect_uri=${encodeURIComponent(
          this.env.X_REDIRECT_URI,
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
                `${this.env.X_CLIENT_ID}:${this.env.X_CLIENT_SECRET}`,
              )}`,
            },
            body: new URLSearchParams({
              code: code || "",
              redirect_uri: this.env.X_REDIRECT_URI,
              grant_type: "authorization_code",
              code_verifier: codeVerifier,
            }),
          },
        );

        if (!tokenResponse.ok) {
          throw new Error(`Twitter API responded with ${tokenResponse.status}`);
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

        await this.env.KV.put(`token:${access_token}`, username);

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

    if (
      !request.headers.get("accept") ||
      !request.headers.get("accept")?.includes("text/html") ||
      request.headers.get("accept")?.includes("text/markdown")
    ) {
      return new Response((textContent || "Not Found") as string, {
        status: textContent === "" ? 404 : 200,
        headers: { "Content-Type": "text/markdown" },
      });
    }

    // Default: serve HTML interface
    return new Response("Not found", {
      status: 404,
    });
  }

  broadcast(path: string, senderSessionId: string, message: WSMessage): void {
    const messageStr = JSON.stringify(message);
    //@ts-ignore
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId !== senderSessionId && session.path === path) {
        try {
          session.webSocket.send(messageStr);
        } catch (err) {
          this.sessions.delete(sessionId);
        }
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route to durable object based on first path segment
    return env.TEXT.get(
      env.TEXT.idFromName(new URL(request.url).pathname.split("/")[1]),
    ).fetch(request);
  },
};
