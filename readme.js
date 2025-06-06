/**
 * Combined TextDO + X OAuth middleware
 * - Any path creates a separate collaborative text area
 * - Anyone can read any text area
 * - Only authenticated X users can write to text areas prefixed with their username
 */

// X OAuth middleware functions
async function generateRandomString(length) {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class TextDO {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
    this.textContent = "";
    this.version = 0;
    this.roomName = "";
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/websocket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      const roomName = url.searchParams.get("room") || "default";
      const username = url.searchParams.get("username") || null;
      await this.handleSession(server, roomName, username);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async handleSession(webSocket, roomName, username) {
    webSocket.accept();
    const sessionId = crypto.randomUUID();
    this.roomName = roomName;

    // Determine if user can write (room must be prefixed with their username)
    const canWrite = username && roomName.startsWith(username + "/");

    this.sessions.set(sessionId, { webSocket, username, canWrite });

    webSocket.send(
      JSON.stringify({
        type: "init",
        sessionId,
        text: this.textContent,
        version: this.version,
        sessionCount: this.sessions.size,
        canWrite,
        roomName,
        username,
      }),
    );

    webSocket.addEventListener("message", (msg) => {
      try {
        const data = JSON.parse(msg.data);
        const session = this.sessions.get(sessionId);

        if (data.type === "text" && session?.canWrite) {
          this.textContent = data.text;
          this.version = data.version;
          this.broadcast(sessionId, {
            type: "text",
            text: data.text,
            version: data.version,
            fromSession: sessionId,
            fromUsername: username,
          });
        }
      } catch (err) {
        console.error("Error:", err);
      }
    });

    webSocket.addEventListener("close", () => {
      this.sessions.delete(sessionId);
      this.broadcast(sessionId, {
        type: "leave",
        sessionId,
        username,
        sessionCount: this.sessions.size,
      });
    });

    this.broadcast(sessionId, {
      type: "join",
      sessionId,
      username,
      sessionCount: this.sessions.size,
    });
  }

  broadcast(senderSessionId, message) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle X OAuth routes
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
      const redirectUri = url.searchParams.get("redirect") || "/";

      const headers = new Headers({
        Location: `https://x.com/i/oauth2/authorize?response_type=code&client_id=${
          env.X_CLIENT_ID
        }&redirect_uri=${encodeURIComponent(
          env.X_REDIRECT_URI,
        )}&scope=${encodeURIComponent(
          "users.read",
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
      headers.append(
        "Set-Cookie",
        `x_redirect_after=${redirectUri}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=600`,
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
      const redirectAfter =
        cookies.find((c) => c.startsWith("x_redirect_after="))?.split("=")[1] ||
        "/";

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
          throw new Error(`Twitter API responded with ${tokenResponse.status}`);
        }

        const { access_token } = await tokenResponse.json();
        const headers = new Headers({ Location: redirectAfter });

        headers.append(
          "Set-Cookie",
          `x_access_token=${encodeURIComponent(
            access_token,
          )}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=34560000`,
        );
        headers.append("Set-Cookie", `x_oauth_state=; Max-Age=0`);
        headers.append("Set-Cookie", `x_code_verifier=; Max-Age=0`);
        headers.append("Set-Cookie", `x_redirect_after=; Max-Age=0`);

        return new Response("Redirecting", { status: 307, headers });
      } catch (error) {
        return new Response(`Login failed: ${error.message}`, { status: 500 });
      }
    }

    // Handle WebSocket connections
    if (url.pathname === "/ws") {
      const roomPath = url.searchParams.get("room") || "default";
      const token = request.headers
        .get("Cookie")
        ?.split(";")
        .find((r) => r.includes("x_access_token"))
        ?.split("=")[1];

      let username = null;
      if (token) {
        try {
          const res = await fetch("https://api.x.com/2/users/me", {
            headers: { Authorization: `Bearer ${decodeURIComponent(token)}` },
          });
          if (res.ok) {
            const { data } = await res.json();
            username = data.username;
          }
        } catch (e) {
          // Username will remain null
        }
      }

      const roomObject = env.TEXT.get(env.TEXT.idFromName(roomPath));
      const newUrl = new URL(url);
      newUrl.pathname = "/websocket";
      newUrl.searchParams.set("room", roomPath);
      if (username) newUrl.searchParams.set("username", username);

      return roomObject.fetch(new Request(newUrl, request));
    }

    // Serve editor for any other path
    const roomPath = url.pathname === "/" ? "default" : url.pathname.slice(1);
    const token = request.headers
      .get("Cookie")
      ?.split(";")
      .find((r) => r.includes("x_access_token"))
      ?.split("=")[1];

    let username = null;
    if (token) {
      try {
        const res = await fetch("https://api.x.com/2/users/me", {
          headers: { Authorization: `Bearer ${decodeURIComponent(token)}` },
        });
        if (res.ok) {
          const { data } = await res.json();
          username = data.username;
        }
      } catch (e) {
        // Username will remain null
      }
    }

    return new Response(generateHTML(roomPath, username), {
      headers: { "Content-Type": "text/html" },
    });
  },
};

function generateHTML(roomPath, username) {
  const canWrite = username && roomPath.startsWith(username + "/");

  return `<!DOCTYPE html>
<html>
<head>
<title>Collaborative Text Editor - ${roomPath}</title>
<style>
body{margin:0;background:#f5f5f5;font-family:Arial,sans-serif;padding:20px}
header{background:white;padding:15px;border-radius:8px;margin-bottom:20px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
#status{color:#666;font-size:14px}
#editor{width:100%;height:400px;padding:15px;border:2px solid #ddd;border-radius:8px;font-family:Monaco,Courier,monospace;font-size:14px;resize:vertical;background:white;box-sizing:border-box}
#editor:focus{border-color:#007bff;outline:none}
#editor:read-only{background:#f8f9fa;border-color:#ccc}
aside{position:fixed;top:20px;right:20px;background:rgba(0,0,0,0.8);color:white;padding:10px;border-radius:5px;min-width:200px;font-size:12px}
.info{margin:5px 0}
.auth-info{background:#007bff;color:white;padding:10px;border-radius:5px;margin-bottom:10px}
.write-access{background:#28a745}
.read-only{background:#6c757d}
footer{margin-top:20px;text-align:center;color:#666}
footer a{color:#007bff;text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>Collaborative Text Editor</h1>
  <h2>Room: /${roomPath}</h2>
  <div id="status">Connecting...</div>
</header>
<textarea id="editor" placeholder="Loading..."></textarea>
<aside id="info"></aside>
<footer>
  <div class="auth-info ${canWrite ? "write-access" : "read-only"}">
    ${
      username
        ? `Logged in as @${username} - ${
            canWrite ? "Can edit this room" : "Read-only access"
          } | <a href="/logout?redirect_to=${encodeURIComponent(
            "/" + roomPath,
          )}" style="color:white">Logout</a>`
        : `Not logged in - Read-only access | <a href="/login?redirect=${encodeURIComponent(
            "/" + roomPath,
          )}" style="color:white">Login with X</a>`
    }
  </div>
  ${
    username && !canWrite
      ? `<p>Create a room like <a href="/${username}/notes">/${username}/notes</a> to edit</p>`
      : ""
  }
</footer>
<script>
class TextApp {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.version = 0;
    this.sessionCount = 0;
    this.canWrite = false;
    this.username = '${username || ""}';
    this.roomPath = '${roomPath}';
    this.statusEl = document.getElementById('status');
    this.infoEl = document.getElementById('info');
    this.editorEl = document.getElementById('editor');
    this.isUpdating = false;
    this.connect();
    this.setupEventListeners();
  }
  
  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + '/ws?room=' + encodeURIComponent(this.roomPath);
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      this.statusEl.textContent = 'Connected - Ready to collaborate!';
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
        this.canWrite = message.canWrite;
        this.statusEl.textContent = 'Connected - Session: ' + this.sessionId.slice(0,8);
        
        this.isUpdating = true;
        const cursorPos = this.editorEl.selectionStart;
        this.editorEl.value = message.text;
        this.editorEl.readOnly = !this.canWrite;
        this.editorEl.placeholder = this.canWrite ? 
          'Start typing... changes will sync in real-time.' :
          'Read-only - Login with X to edit rooms prefixed with your username.';
        this.editorEl.setSelectionRange(cursorPos, cursorPos);
        this.isUpdating = false;
        
        this.updateInfo();
        break;
        
      case 'text':
        if (message.fromSession !== this.sessionId) {
          this.isUpdating = true;
          const cursorPos = this.editorEl.selectionStart;
          this.editorEl.value = message.text;
          this.version = message.version;
          this.editorEl.setSelectionRange(cursorPos, cursorPos);
          this.isUpdating = false;
        }
        this.updateInfo();
        break;
        
      case 'join':
        this.sessionCount = message.sessionCount;
        this.updateInfo();
        break;
        
      case 'leave':
        this.sessionCount = message.sessionCount;
        this.updateInfo();
        break;
    }
  }
  
  updateInfo() {
    this.infoEl.innerHTML = 
      '<div class="info"><strong>Session:</strong> ' + this.sessionId?.slice(0,8) + '</div>' +
      '<div class="info"><strong>Connected:</strong> ' + this.sessionCount + '</div>' +
      '<div class="info"><strong>Version:</strong> ' + this.version + '</div>' +
      '<div class="info"><strong>Characters:</strong> ' + this.editorEl.value.length + '</div>' +
      '<div class="info"><strong>Access:</strong> ' + (this.canWrite ? 'Read/Write' : 'Read-only') + '</div>';
  }
  
  setupEventListeners() {
    if (!this.canWrite) return;
    
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
        lastSendTime = now;
        this.updateInfo();
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
}
