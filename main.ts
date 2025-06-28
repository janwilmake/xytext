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
  path?: string;
  files?: FileInfo[];
}

interface FileInfo {
  path: string;
  content: string;
  created_at: number;
  updated_at: number;
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
  }

  deleteFile(path: string): boolean {
    const result = this.sql.exec(
      `DELETE FROM documents WHERE path = ?`,
      path,
    ).rowsRead;
    return result > 0;
  }

  getAllFiles(username: string): FileInfo[] {
    const files = this.sql
      .exec(
        `SELECT path, content, created_at, updated_at FROM documents WHERE path LIKE ?`,
        `/${username}/%`,
      )
      .toArray() as unknown as FileInfo[];
    return files;
  }

  async getUsernameFromToken(token: string): Promise<string> {
    if (!token) return "anonymous";
    const username = await this.env.KV.get(
      `token:${decodeURIComponent(token)}`,
    );
    return username || "anonymous";
  }

  generateLlmsTxt(username: string): string {
    const files = this.getAllFiles(username);
    const baseUrl = `https://${
      this.env.ENVIRONMENT === "development" ? "localhost:3000" : "xytext.com"
    }`;

    let llmsTxt = `# ${username}'s Files\n\n`;
    llmsTxt += `This document lists all available files for ${username}.\n\n`;

    files.forEach((file) => {
      llmsTxt += `${baseUrl}${file.path}\n`;
    });

    if (files.length === 0) {
      llmsTxt += `No files available for ${username}.\n`;
    }

    return llmsTxt;
  }

  parseMarkdownSections(content: string) {
    const lines = content.split("\n");
    const sections = [];
    let currentSection = {
      title: "Document Start",
      content: "",
      startLine: 1,
      endLine: 1,
      level: 0,
      id: "doc-start",
    };

    let lineNumber = 1;
    let sectionCounter = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headerMatch) {
        if (currentSection.content.trim() || sections.length === 0) {
          currentSection.endLine = Math.max(
            lineNumber - 1,
            currentSection.startLine,
          );
          sections.push({ ...currentSection });
        }

        const level = headerMatch[1].length;
        const title = headerMatch[2].trim();
        sectionCounter++;

        currentSection = {
          title: title,
          content: line + "\n",
          startLine: lineNumber,
          endLine: lineNumber,
          level: level,
          id: `section-${sectionCounter}-${title
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "-")}`,
        };
      } else {
        currentSection.content += line + "\n";
      }
      lineNumber++;
    }

    if (currentSection.content.trim() || sections.length === 0) {
      currentSection.endLine = lineNumber - 1;
      sections.push(currentSection);
    }

    return sections;
  }

  renderSectionsHTML(sections: any[]) {
    if (sections.length === 0) {
      return '<div class="no-sections">No sections found</div>';
    }

    return sections
      .map((section, index) => {
        const levelClass = `section-level-${Math.min(section.level, 6)}`;
        const escapeHtml = (text: string) =>
          text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

        return `
        <div class="section-item ${levelClass}" 
             data-section-index="${index}"
             data-start-line="${section.startLine}">
          <div class="section-title">${escapeHtml(section.title)}</div>
          <div class="section-meta">
            H${section.level} • Lines ${section.startLine}-${section.endLine}
          </div>
        </div>
      `;
      })
      .join("");
  }

  renderFilesHTML(files: FileInfo[], currentPath: string) {
    if (files.length === 0) {
      return '<div class="no-files">No files found</div>';
    }

    const getRelativeTime = (timestamp: number) => {
      const now = Date.now();
      const diff = now - timestamp;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);

      if (minutes < 1) return "Just now";
      if (minutes < 60) return `${minutes}m ago`;
      if (hours < 24) return `${hours}h ago`;
      return `${days}d ago`;
    };

    const escapeHtml = (text: string) =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    return files
      .map((file) => {
        const isActive = file.path === currentPath;
        const fileName = file.path.split("/").pop() || "Untitled";
        const relativeDate = getRelativeTime(file.updated_at);

        return `
        <div class="file-item ${isActive ? "active" : ""}" 
             data-path="${file.path}"
             onclick="window.location.href='${file.path}'"
             oncontextmenu="event.preventDefault(); window.collaborativeEditor?.showContextMenu(event, this)">
          <div>
            <div class="file-name">${escapeHtml(fileName)}</div>
            <div class="file-meta">${relativeDate}</div>
          </div>
        </div>
      `;
      })
      .join("");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = this.env.ENVIRONMENT === "development";

    const pathSegments = url.pathname.split("/").filter((p) => p);
    const firstSegment = pathSegments[0] || "default";

    // Handle llms.txt endpoint
    if (pathSegments.length === 2 && pathSegments[1] === "llms.txt") {
      const username = pathSegments[0];
      const llmsTxt = this.generateLlmsTxt(username);
      return new Response(llmsTxt, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    const isRoot = pathSegments.length === 1;
    let username = "admin";
    if (!isLocalhost) {
      const token = request.headers
        .get("Cookie")
        ?.split(";")
        .find((r) => r.includes("x_access_token"))
        ?.split("=")[1];
      username = await this.getUsernameFromToken(token || "");
    }

    // Updated admin logic: admin privileges for own files OR anonymous files
    const isAdmin =
      username === "admin" ||
      firstSegment === username ||
      firstSegment === "anonymous";

    // Handle file deletion
    if (request.method === "DELETE" && isAdmin) {
      const deleted = this.deleteFile(url.pathname);
      if (deleted) {
        // Broadcast file deletion to all sessions
        this.broadcastFileUpdate(firstSegment);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Load existing content
    let textContent =
      this.sql
        .exec(`SELECT content FROM documents WHERE path = ?`, url.pathname)
        .toArray()[0]?.content || "";

    if (isRoot) {
      const files = this.sql
        .exec(
          `SELECT path,created_at,updated_at FROM documents WHERE path LIKE ?`,
          `/${firstSegment}/%`,
        )
        .toArray();
      textContent = `# Root of ${firstSegment}
          
          
Go to any subpath of /${firstSegment}/* to start ${
        isAdmin ? "editing" : "watching"
      } a file.

Available files:

${files
  .map(
    (file) =>
      `- [${file.path}](${file.path}) - Created: ${new Date(
        file.created_at as number,
      ).toLocaleString()}, Updated: ${new Date(
        file.updated_at as number,
      ).toLocaleString()}`,
  )
  .join("\n")}
`;
    }

    // WebSocket handling
    if (request.headers.get("Upgrade") === "websocket") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      const sessionId = crypto.randomUUID();

      this.sessions.set(sessionId, {
        path: url.pathname,
        webSocket: server,
        username,
        isAdmin,
      });

      const files = this.getAllFiles(firstSegment);

      server.send(
        JSON.stringify({
          type: "init",
          sessionId,
          text: textContent,
          version: this.version,
          sessionCount: this.sessions.size,
          isAdmin,
          username,
          files,
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
            // Also broadcast file update to refresh file list
            this.broadcastFileUpdate(firstSegment);
          } else if (data.type === "delete_file" && isAdmin && data.path) {
            // Delete file
            this.deleteFile(data.path);
            this.broadcastFileUpdate(firstSegment);
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

    // OAuth endpoints (unchanged)
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
          Location: url.searchParams.get("redirect") || "/" + username,
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

    // Return raw content for non-HTML requests
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

    if (url.pathname === "/") {
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XYText - Home</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 40px; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { color: #333; }
        .btn { background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 10px 0; }
        .btn:hover { background: #0056b3; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome to XYText</h1>
        <p>Collaborative Monaco Editor with file management.</p>
        <a href="/login" class="btn">Get Started</a>
    </div>
</body>
</html>`,
        {
          headers: { "content-type": "text/html;charset=utf8" },
        },
      );
    }

    // Prepare initial data for the app
    const files = this.getAllFiles(firstSegment);
    const sections = this.parseMarkdownSections(textContent as string);
    const token = request.headers
      .get("Cookie")
      ?.split(";")
      .find((c) => c.includes("x_access_token"))
      ?.split("=")[1];

    // Render sections and files HTML on server-side
    const sectionsHTML = this.renderSectionsHTML(sections);
    const filesHTML = this.renderFilesHTML(files, url.pathname);

    // Default: serve HTML interface with all data pre-rendered
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XYText - Collaborative Monaco Editor</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            height: 100vh; overflow: hidden; transition: background-color 0.3s ease, color 0.3s ease;
            background-color: #ffffff; color: #24292e;
        }
        @media (prefers-color-scheme: dark) {
            body { background-color: #1e1e1e; color: #d4d4d4; }
        }
        .header {
            background: white; padding: 10px 15px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            border-bottom: 1px solid #e1e4e8; z-index: 1000; position: relative;
        }
        @media (prefers-color-scheme: dark) {
            .header { background: #2d2d30; border-bottom-color: #464647; }
        }
        .header-content {
            display: flex; align-items: center; justify-content: space-between;
            flex-wrap: wrap; gap: 15px;
        }
        .header-left { display: flex; flex-direction: column; }
        .header-left h1 { margin: 0; font-size: 18px; color: #24292e; }
        @media (prefers-color-scheme: dark) {
            .header-left h1 { color: #cccccc; }
        }
        .header-right { display: flex; align-items: center; gap: 15px; }
        #status { color: #666; font-size: 12px; margin-top: 2px; }
        @media (prefers-color-scheme: dark) {
            #status { color: #969696; }
        }
        .app-container { display: flex; height: calc(100vh - 70px); width: 100vw; }
        .sidebar {
            width: 250px; min-width: 200px; max-width: 400px; background: #f8f9fa;
            border-right: 1px solid #e1e4e8; overflow: hidden; display: flex;
            flex-direction: column; resize: horizontal;
        }
        @media (prefers-color-scheme: dark) {
            .sidebar { background: #252526; border-right-color: #464647; }
        }
        .sidebar-header {
            padding: 15px 20px; background: #ffffff; border-bottom: 1px solid #e1e4e8;
            font-weight: 600; font-size: 14px; color: #24292e;
        }
        @media (prefers-color-scheme: dark) {
            .sidebar-header { background: #2d2d30; border-bottom-color: #464647; color: #cccccc; }
        }
        .cursor-info {
            padding: 10px 20px; background: #f6f8fa; border-bottom: 1px solid #e1e4e8;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            font-size: 12px; color: #586069;
        }
        @media (prefers-color-scheme: dark) {
            .cursor-info { background: #2d2d30; border-bottom-color: #464647; color: #969696; }
        }
        .sections-container { flex: 1; overflow-y: auto; padding: 10px 0; }
        .section-item {
            padding: 8px 20px; cursor: pointer; transition: background-color 0.2s ease;
            border-left: 3px solid transparent; font-size: 13px; line-height: 1.4;
        }
        .section-item:hover { background: #f0f2f5; }
        @media (prefers-color-scheme: dark) {
            .section-item:hover { background: #2a2d2e; }
        }
        .section-item.active {
            background: #e3f2fd; border-left-color: #2196f3; font-weight: 500;
        }
        @media (prefers-color-scheme: dark) {
            .section-item.active { background: #094771; border-left-color: #007acc; }
        }
        .section-title { color: #24292e; margin-bottom: 2px; }
        @media (prefers-color-scheme: dark) {
            .section-title { color: #cccccc; }
        }
        .section-meta {
            color: #586069; font-size: 11px;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
        }
        @media (prefers-color-scheme: dark) {
            .section-meta { color: #969696; }
        }
        .section-level-1 { padding-left: 20px; }
        .section-level-2 { padding-left: 35px; }
        .section-level-3 { padding-left: 50px; }
        .section-level-4 { padding-left: 65px; }
        .section-level-5 { padding-left: 80px; }
        .section-level-6 { padding-left: 95px; }
        .editor-container { flex: 1; position: relative; min-width: 400px; }
        .editor-wrapper { height: 100%; border: none; }
        .file-sidebar {
            width: 250px; min-width: 200px; max-width: 400px; background: #f8f9fa;
            border-left: 1px solid #e1e4e8; overflow: hidden; display: flex;
            flex-direction: column; resize: horizontal;
        }
        @media (prefers-color-scheme: dark) {
            .file-sidebar { background: #252526; border-left-color: #464647; }
        }
        .file-sidebar-header {
            padding: 15px 20px; background: #ffffff; border-bottom: 1px solid #e1e4e8;
            font-weight: 600; font-size: 14px; color: #24292e; display: flex;
            justify-content: space-between; align-items: center;
        }
        @media (prefers-color-scheme: dark) {
            .file-sidebar-header { background: #2d2d30; border-bottom-color: #464647; color: #cccccc; }
        }
        .add-file-btn {
            background: #28a745; color: white; border: none; border-radius: 3px;
            padding: 4px 8px; cursor: pointer; font-size: 12px;
        }
        .add-file-btn:hover { background: #218838; }
        .add-file-btn:disabled { background: #6c757d; cursor: not-allowed; }
        .files-container { flex: 1; overflow-y: auto; padding: 10px 0; }
        .file-item {
            padding: 8px 20px; cursor: pointer; transition: background-color 0.2s ease;
            border-left: 3px solid transparent; font-size: 13px; line-height: 1.4;
            display: flex; justify-content: space-between; align-items: center;
        }
        .file-item:hover { background: #f0f2f5; }
        @media (prefers-color-scheme: dark) {
            .file-item:hover { background: #2a2d2e; }
        }
        .file-item.active {
            background: #e3f2fd; border-left-color: #2196f3; font-weight: 500;
        }
        @media (prefers-color-scheme: dark) {
            .file-item.active { background: #094771; border-left-color: #007acc; }
        }
        .file-name { color: #24292e; margin-bottom: 2px; flex: 1; }
        @media (prefers-color-scheme: dark) {
            .file-name { color: #cccccc; }
        }
        .file-meta {
            color: #586069; font-size: 11px;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
        }
        @media (prefers-color-scheme: dark) {
            .file-meta { color: #969696; }
        }
        .resize-handle { width: 4px; background: transparent; cursor: col-resize; position: relative; }
        .resize-handle:hover { background: #2196f3; }
        @media (prefers-color-scheme: dark) {
            .resize-handle:hover { background: #007acc; }
        }
        .no-sections { padding: 20px; text-align: center; color: #586069; font-style: italic; }
        @media (prefers-color-scheme: dark) {
            .no-sections { color: #969696; }
        }
        .no-files { padding: 20px; text-align: center; color: #586069; font-style: italic; }
        @media (prefers-color-scheme: dark) {
            .no-files { color: #969696; }
        }
        .btn {
            background: #007bff; color: white; padding: 6px 12px; text-decoration: none;
            border-radius: 4px; border: none; cursor: pointer; font-size: 12px;
        }
        .btn:hover { background: #0056b3; }
        .connection-info {
            font-size: 12px; color: #666;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
        }
        @media (prefers-color-scheme: dark) {
            .connection-info { color: #969696; }
        }
        .readonly .resize-handle { display: none; }
        .context-menu {
            position: fixed; background: white; border: 1px solid #ccc; border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2); z-index: 10000; min-width: 120px; display: none;
        }
        @media (prefers-color-scheme: dark) {
            .context-menu { background: #2d2d30; border-color: #464647; }
        }
        .context-menu-item {
            padding: 8px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid #eee;
        }
        @media (prefers-color-scheme: dark) {
            .context-menu-item { color: #cccccc; border-bottom-color: #464647; }
        }
        .context-menu-item:last-child { border-bottom: none; }
        .context-menu-item:hover { background: #f5f5f5; }
        @media (prefers-color-scheme: dark) {
            .context-menu-item:hover { background: #2a2d2e; }
        }
        .context-menu-item.delete { color: #dc3545; }
        .context-menu-item.delete:hover { background: #f8d7da; }
        @media (prefers-color-scheme: dark) {
            .context-menu-item.delete:hover { background: #5c2e31; }
        }
        @media (max-width: 768px) {
            .header-content { flex-direction: column; align-items: stretch; }
            .sidebar, .file-sidebar { width: 200px; min-width: 150px; }
        }
    </style>
</head>
<body>
    <header class="header">
        <div class="header-content">
            <div class="header-left">
                <h1>XYText - Collaborative Monaco Editor</h1>
                <div id="status">Connecting...</div>
            </div>
            <div class="header-right">
                <div class="connection-info" id="connectionInfo"></div>
                <div id="authSection">${
                  isLocalhost
                    ? '<span style="color: #666; font-size: 12px;">Localhost Mode</span>'
                    : token
                    ? '<a href="/logout" class="btn">Logout</a>'
                    : '<a href="/login" class="btn">Login with X</a>'
                }</div>
            </div>
        </div>
    </header>

    <div class="app-container" id="container">
        <div class="sidebar" id="sidebar">
            <div class="sidebar-header">📖 Document Outline</div>
            <div class="cursor-info" id="cursorInfo">Line 1, Column 1</div>
            <div class="sections-container" id="sectionsContainer">${sectionsHTML}</div>
        </div>
        <div class="resize-handle" id="resizeHandle"></div>
        <div class="editor-container">
            <div id="editor" class="editor-wrapper"></div>
        </div>
        <div class="resize-handle" id="fileResizeHandle"></div>
        <div class="file-sidebar" id="fileSidebar">
            <div class="file-sidebar-header">
                📁 Files
                <button class="add-file-btn" id="addFileBtn" ${
                  !isAdmin && firstSegment !== "anonymous" ? "disabled" : ""
                }>+</button>
            </div>
            <div class="files-container" id="filesContainer">${filesHTML}</div>
        </div>
    </div>

    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item delete" id="deleteFileItem">Delete File</div>
    </div>

    <script src="https://unpkg.com/monaco-editor@0.44.0/min/vs/loader.js"></script>
    <script>
        window.initialData = {
            content: ${JSON.stringify(textContent)},
            files: ${JSON.stringify(files)},
            sections: ${JSON.stringify(sections)},
            currentPath: ${JSON.stringify(url.pathname)},
            username: ${JSON.stringify(firstSegment)},
            isAdmin: ${JSON.stringify(isAdmin)},
            isLocalhost: ${JSON.stringify(isLocalhost)}
        };

        class CollaborativeMonacoEditor {
            constructor() {
                this.editor = null;
                this.ws = null;
                this.sessionId = null;
                this.version = 0;
                this.sessionCount = 0;
                this.isAdmin = window.initialData.isAdmin;
                this.username = window.initialData.username;
                this.isUpdating = false;
                this.files = window.initialData.files;
                this.sections = window.initialData.sections;
                this.activeSection = null;
                this.activeSectionIndex = -1;
                this.isResizing = false;
                this.statusEl = document.getElementById('status');
                this.connectionInfoEl = document.getElementById('connectionInfo');
                this.containerEl = document.getElementById('container');
                this.addFileBtnEl = document.getElementById('addFileBtn');
                this.contextMenuEl = document.getElementById('contextMenu');
                this.deleteFileItemEl = document.getElementById('deleteFileItem');
                this.currentPath = window.initialData.currentPath;
                this.isLocalhost = window.initialData.isLocalhost;
                this.initialize();
            }

            async initialize() {
                await this.setupMonaco();
                this.setupResizeHandles();
                this.setupThemeListener();
                this.setupFileManagement();
                this.setupContextMenu();
                this.setupSectionClickHandlers();
                this.connect();
                console.log('🚀 Collaborative Monaco Editor initialized successfully');
            }

            setupMonaco() {
                return new Promise((resolve) => {
                    require.config({ paths: { 'vs': 'https://unpkg.com/monaco-editor@0.44.0/min/vs' } });
                    require(['vs/editor/editor.main'], () => {
                        const currentTheme = this.getSystemTheme();
                        this.editor = monaco.editor.create(document.getElementById('editor'), {
                            value: window.initialData.content,
                            language: 'markdown',
                            theme: currentTheme,
                            automaticLayout: true,
                            wordWrap: 'on',
                            minimap: { enabled: true },
                            scrollBeyondLastLine: false,
                            fontSize: 14,
                            lineHeight: 20,
                            padding: { top: 15, bottom: 15 },
                            rulers: [80, 120],
                            renderWhitespace: 'selection',
                            smoothScrolling: true,
                            cursorBlinking: 'smooth',
                            cursorSmoothCaretAnimation: 'on',
                            readOnly: !this.isAdmin
                        });
                        this.setupEditorEventListeners();
                        window.monacoEditor = this.editor;
                        window.collaborativeEditor = this;
                        resolve();
                    });
                });
            }

            setupEditorEventListeners() {
                if (!this.editor) return;
                this.editor.onDidChangeModelContent((event) => {
                    if (!this.isUpdating && this.isAdmin) {
                        this.sendContentChange();
                    }
                    this.updateSections();
                });
                this.editor.onDidChangeCursorPosition((event) => {
                    this.updateCursorInfo();
                    this.updateActiveSection();
                });
                this.editor.onDidChangeCursorSelection((event) => {
                    this.updateCursorInfo();
                    this.updateActiveSection();
                });
            }

            setupFileManagement() {
                this.addFileBtnEl.addEventListener('click', () => {
                    this.createNewFile();
                });
            }

            setupContextMenu() {
                document.addEventListener('click', () => {
                    this.contextMenuEl.style.display = 'none';
                });
                this.deleteFileItemEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.contextMenuTarget) {
                        this.deleteFile(this.contextMenuTarget.dataset.path);
                    }
                    this.contextMenuEl.style.display = 'none';
                });
            }

            createNewFile() {
                if (!this.canManageFiles()) return;
                const fileName = prompt('Enter file name:');
                if (!fileName) return;
                const newPath = \`/\${this.username}/\${fileName}\`;
                window.location.pathname = newPath;
            }

            deleteFile(path) {
                if (!this.canManageFiles()) return;
                if (confirm(\`Are you sure you want to delete \${path}?\`)) {
                    fetch(path, { method: 'DELETE' })
                        .then(response => response.json())
                        .then(data => {
                            if (data.success) {
                                if (this.currentPath === path) {
                                    window.location.href = \`/\${this.username}\`;
                                }
                            } else {
                                alert('Failed to delete file');
                            }
                        })
                        .catch(err => {
                            console.error('Error deleting file:', err);
                            alert('Failed to delete file');
                        });
                }
            }

            canManageFiles() {
                return this.isAdmin || this.currentPath.startsWith('/anonymous/');
            }

            showContextMenu(event, target) {
                if (!this.canManageFiles()) return;
                this.contextMenuTarget = target;
                this.contextMenuEl.style.display = 'block';
                this.contextMenuEl.style.left = event.pageX + 'px';
                this.contextMenuEl.style.top = event.pageY + 'px';
            }

            sendContentChange() {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAdmin) return;
                this.version++;
                this.ws.send(JSON.stringify({
                    type: 'text',
                    text: this.editor.getValue(),
                    version: this.version
                }));
                this.updateConnectionInfo();
            }

            connect() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = protocol + '//' + window.location.host + this.currentPath;
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
                        if (message.files) {
                            this.files = message.files;
                            this.renderFiles();
                        }
                        this.statusEl.textContent = \`Connected - \${this.isAdmin ? 'Editor' : 'Read-only'}\`;
                        this.isUpdating = true;
                        if (this.editor) {
                            const position = this.editor.getPosition();
                            this.editor.setValue(message.text);
                            this.editor.setPosition(position);
                        }
                        this.isUpdating = false;
                        if (!this.isAdmin && this.editor) {
                            this.editor.updateOptions({ readOnly: true });
                        }
                        this.addFileBtnEl.disabled = !this.canManageFiles();
                        this.updateSections();
                        this.updateConnectionInfo();
                        break;
                    case 'text':
                        if (message.fromSession !== this.sessionId && this.editor) {
                            this.isUpdating = true;
                            const position = this.editor.getPosition();
                            this.editor.setValue(message.text);
                            this.version = message.version;
                            if (this.isAdmin) {
                                this.editor.setPosition(position);
                            }
                            this.isUpdating = false;
                            this.updateSections();
                        }
                        break;
                    case 'files_update':
                        if (message.files) {
                            this.files = message.files;
                            this.renderFiles();
                        }
                        break;
                    case 'join':
                    case 'leave':
                        this.sessionCount = message.sessionCount;
                        this.updateConnectionInfo();
                        break;
                }
            }

            parseMarkdownSections() {
                if (!this.editor) return { sections: [], activeSection: null, activeSectionIndex: -1 };
                const content = this.editor.getValue();
                const position = this.editor.getPosition();
                const lines = content.split('\\n');
                const sections = [];
                let currentSection = { title: 'Document Start', content: '', startLine: 1, endLine: 1, level: 0, id: 'doc-start' };
                let lineNumber = 1;
                let sectionCounter = 0;
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const headerMatch = line.match(/^(#{1,6})\\s+(.+)$/);
                    if (headerMatch) {
                        if (currentSection.content.trim() || sections.length === 0) {
                            currentSection.endLine = Math.max(lineNumber - 1, currentSection.startLine);
                            sections.push({ ...currentSection });
                        }
                        const level = headerMatch[1].length;
                        const title = headerMatch[2].trim();
                        sectionCounter++;
                        currentSection = {
                            title: title, content: line + '\\n', startLine: lineNumber, endLine: lineNumber,
                            level: level, id: \`section-\${sectionCounter}-\${title.toLowerCase().replace(/[^a-z0-9]/g, '-')}\`
                        };
                    } else {
                        currentSection.content += line + '\\n';
                    }
                    lineNumber++;
                }
                if (currentSection.content.trim() || sections.length === 0) {
                    currentSection.endLine = lineNumber - 1;
                    sections.push(currentSection);
                }
                const cursorLine = position.lineNumber;
                let activeSection = null;
                let activeSectionIndex = -1;
                for (let i = 0; i < sections.length; i++) {
                    const section = sections[i];
                    if (cursorLine >= section.startLine && cursorLine <= section.endLine) {
                        activeSection = section;
                        activeSectionIndex = i;
                        break;
                    }
                }
                return { sections, activeSection, activeSectionIndex };
            }

            updateSections() {
                const result = this.parseMarkdownSections();
                this.sections = result.sections;
                this.activeSection = result.activeSection;
                this.activeSectionIndex = result.activeSectionIndex;
                this.renderSidebar();
                this.updateCursorInfo();
            }

            updateActiveSection() {
                if (!this.editor || this.sections.length === 0) return;
                const position = this.editor.getPosition();
                const cursorLine = position.lineNumber;
                let newActiveSection = null;
                let newActiveSectionIndex = -1;
                for (let i = 0; i < this.sections.length; i++) {
                    const section = this.sections[i];
                    if (cursorLine >= section.startLine && cursorLine <= section.endLine) {
                        newActiveSection = section;
                        newActiveSectionIndex = i;
                        break;
                    }
                }
                if (newActiveSectionIndex !== this.activeSectionIndex) {
                    this.activeSection = newActiveSection;
                    this.activeSectionIndex = newActiveSectionIndex;
                    this.updateSidebarActiveState();
                }
            }

            renderSidebar() {
                const container = document.getElementById('sectionsContainer');
                if (!container) return;
                if (this.sections.length === 0) {
                    container.innerHTML = '<div class="no-sections">No sections found</div>';
                    return;
                }
                const sectionsHtml = this.sections.map((section, index) => {
                    const isActive = index === this.activeSectionIndex;
                    const levelClass = \`section-level-\${Math.min(section.level, 6)}\`;
                    return \`
                        <div class="section-item \${isActive ? 'active' : ''} \${levelClass}" 
                             data-section-index="\${index}"
                             data-start-line="\${section.startLine}">
                            <div class="section-title">\${this.escapeHtml(section.title)}</div>
                            <div class="section-meta">
                                H\${section.level} • Lines \${section.startLine}-\${section.endLine}
                            </div>
                        </div>
                    \`;
                }).join('');
                container.innerHTML = sectionsHtml;
                this.setupSectionClickHandlers();
            }

            updateSidebarActiveState() {
                const sectionItems = document.querySelectorAll('.section-item');
                sectionItems.forEach((item, index) => {
                    if (index === this.activeSectionIndex) {
                        item.classList.add('active');
                    } else {
                        item.classList.remove('active');
                    }
                });
            }

            setupSectionClickHandlers() {
                const sectionItems = document.querySelectorAll('.section-item');
                sectionItems.forEach((item) => {
                    item.addEventListener('click', () => {
                        const startLine = parseInt(item.getAttribute('data-start-line'));
                        this.navigateToLine(startLine);
                    });
                });
            }

            navigateToLine(lineNumber) {
                if (!this.editor) return;
                this.editor.revealLineInCenter(lineNumber);
                this.editor.setPosition({ lineNumber: lineNumber, column: 1 });
                this.editor.focus();
            }

            updateCursorInfo() {
                if (!this.editor) return;
                const position = this.editor.getPosition();
                const selection = this.editor.getSelection();
                const cursorInfoElement = document.getElementById('cursorInfo');
                if (!cursorInfoElement) return;
                let text = \`Line \${position.lineNumber}, Column \${position.column}\`;
                if (!selection.isEmpty()) {
                    const selectedText = this.editor.getModel().getValueInRange(selection);
                    const lineCount = selectedText.split('\\n').length;
                    const charCount = selectedText.length;
                    text += \` • \${charCount} chars, \${lineCount} lines selected\`;
                }
                if (this.activeSection) {
                    text += \` • \${this.activeSection.title}\`;
                }
                cursorInfoElement.textContent = text;
            }

            updateConnectionInfo() {
                this.connectionInfoEl.innerHTML = '<div><strong>' + (this.username || 'connecting...') + '</strong> • ' +
                    (this.isAdmin ? 'Editor' : 'Read-only') + ' • ' +
                    this.sessionCount + ' user' + (this.sessionCount !== 1 ? 's' : '') + ' • ' +
                    'v' + this.version + '</div>';
            }

            renderFiles() {
                const container = document.getElementById('filesContainer');
                if (!container) return;
                if (this.files.length === 0) {
                    container.innerHTML = '<div class="no-files">No files found</div>';
                    return;
                }
                const getRelativeTime = (timestamp) => {
                    const now = Date.now();
                    const diff = now - timestamp;
                    const minutes = Math.floor(diff / 60000);
                    const hours = Math.floor(diff / 3600000);
                    const days = Math.floor(diff / 86400000);
                    if (minutes < 1) return 'Just now';
                    if (minutes < 60) return \`\${minutes}m ago\`;
                    if (hours < 24) return \`\${hours}h ago\`;
                    return \`\${days}d ago\`;
                };
                const filesHtml = this.files.map((file) => {
                    const isActive = file.path === this.currentPath;
                    const fileName = file.path.split('/').pop() || 'Untitled';
                    const relativeDate = getRelativeTime(file.updated_at);
                    return \`
                        <div class="file-item \${isActive ? 'active' : ''}" 
                             data-path="\${file.path}"
                             onclick="window.location.href='\${file.path}'"
                             oncontextmenu="event.preventDefault(); window.collaborativeEditor?.showContextMenu(event, this)">
                            <div>
                                <div class="file-name">\${this.escapeHtml(fileName)}</div>
                                <div class="file-meta">\${relativeDate}</div>
                            </div>
                        </div>
                    \`;
                }).join('');
                container.innerHTML = filesHtml;
            }

            setupResizeHandles() {
                const resizeHandle = document.getElementById('resizeHandle');
                const sidebar = document.getElementById('sidebar');
                const fileResizeHandle = document.getElementById('fileResizeHandle');
                const fileSidebar = document.getElementById('fileSidebar');
                if (resizeHandle && sidebar) {
                    resizeHandle.addEventListener('mousedown', (e) => {
                        this.startResize(e, 'left', sidebar);
                    });
                }
                if (fileResizeHandle && fileSidebar) {
                    fileResizeHandle.addEventListener('mousedown', (e) => {
                        this.startResize(e, 'right', fileSidebar);
                    });
                }
            }

            startResize(e, direction, element) {
                this.isResizing = true;
                this.resizeDirection = direction;
                this.resizeElement = element;
                document.addEventListener('mousemove', this.handleResize.bind(this));
                document.addEventListener('mouseup', this.stopResize.bind(this));
                e.preventDefault();
            }

            handleResize(e) {
                if (!this.isResizing || !this.resizeElement) return;
                let newWidth;
                if (this.resizeDirection === 'left') {
                    newWidth = Math.max(200, Math.min(500, e.clientX));
                } else {
                    newWidth = Math.max(200, Math.min(500, window.innerWidth - e.clientX));
                }
                this.resizeElement.style.width = \`\${newWidth}px\`;
                if (this.editor) {
                    this.editor.layout();
                }
            }

            stopResize() {
                this.isResizing = false;
                this.resizeDirection = null;
                this.resizeElement = null;
                document.removeEventListener('mousemove', this.handleResize.bind(this));
                document.removeEventListener('mouseup', this.stopResize.bind(this));
            }

            getSystemTheme() {
                return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs';
            }

            setupThemeListener() {
                const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
                mediaQuery.addEventListener('change', (e) => {
                    const newTheme = e.matches ? 'vs-dark' : 'vs';
                    if (this.editor) {
                        monaco.editor.setTheme(newTheme);
                    }
                });
            }

            escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
        }

        let app;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                app = new CollaborativeMonacoEditor();
            });
        } else {
            app = new CollaborativeMonacoEditor();
        }
        window.collaborativeMonacoApp = app;
    </script>
</body>
</html>`,
      {
        headers: { "content-type": "text/html;charset=utf8" },
      },
    );
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

  broadcastFileUpdate(username: string): void {
    const files = this.getAllFiles(username);
    const message: WSMessage = {
      type: "files_update",
      files,
    };
    const messageStr = JSON.stringify(message);

    //@ts-ignore
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.path.startsWith(`/${username}/`)) {
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
      env.TEXT.idFromName(new URL(request.url).pathname.split("/")[1] + ":v2"),
    ).fetch(request);
  },
};
