// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

import {
  Queryable,
  QueryableHandler,
  studioMiddleware,
} from "queryable-object";
import { DurableObject } from "cloudflare:workers";

const chevronRightSvg = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path fill-rule="evenodd" clip-rule="evenodd" d="M10.0719 8.02397L5.7146 3.66666L6.33332 3.04794L11 7.71461V8.33333L6.33332 13L5.7146 12.3813L10.0719 8.02397Z" fill="currentColor"/></svg>`;
const chevronDownSvg = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path fill-rule="evenodd" clip-rule="evenodd" d="M7.97612 10.0719L12.3334 5.7146L12.9521 6.33332L8.28548 11L7.66676 11L3.0001 6.33332L3.61882 5.7146L7.97612 10.0719Z" fill="currentColor"/>
</svg>`;

interface Env {
  TEXT: DurableObjectNamespace<TextDO & QueryableHandler>;
  ADMIN_SECRET: string;
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
  name: string;
  profile_image_url: string;
  isAdmin: boolean;
  /** Only calculated dynamically from UIState  */
  is_tab_foreground?: 0 | 1;
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
  sessions?: Session[];
  files?: FileNode[];
  explorer_data?: ExplorerData;
  ui_state?: UIState;
  line?: number;
  column?: number;
  is_tab_foreground?: 0 | 1;
}

interface FileNode extends VisibleNode {
  id: number;
  path: string;
  name: string;
  parent_path: string | null;
  type: "file" | "folder";
  size: number;
  created_at: number;
  updated_at: number;
  content?: string;
  is_expanded: 0 | 1;
  last_cursor_line: number;
  last_cursor_column: number;
}

/** Subset of FileNode for Explorer */
interface VisibleNode extends Record<string, SqlStorageValue> {
  path: string;
  parent_path: string;
  type: "file" | "folder";
  name: string;
  is_expanded: 0 | 1;
}

interface UIState extends Record<string, SqlStorageValue> {
  username: string;
  explorer_scroll_top_path: string | null;
  last_open_path: string | null;
  is_tab_foreground: 0 | 1;
  follow_username: string | null;
  profile_image_url: string | null;
  name: string | null;
  updated_at: number;
}

interface ExplorerData {
  visible_nodes: VisibleNode[];
  sessions: Session[];
  pathViewers: Record<string, Session[]>;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}
interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url: string;
  verified?: boolean;
}

async function generateRandomString(length: number): Promise<string> {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0")
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

@Queryable()
export class TextDO extends DurableObject {
  private lastStateUpdate = 0;
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
    // Main nodes table for hierarchical file structure
    this.sql.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      parent_path TEXT,
      type TEXT CHECK(type IN ('file', 'folder')) NOT NULL,
      size INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      content TEXT,
      is_expanded BOOLEAN DEFAULT FALSE,
      last_cursor_line INTEGER DEFAULT 1,
      last_cursor_column INTEGER DEFAULT 1
    )
  `);

    this.sql.exec(`
  CREATE TABLE IF NOT EXISTS user_ui (
    username TEXT PRIMARY KEY,
    explorer_scroll_top_path TEXT,
    last_open_path TEXT,
    is_tab_foreground INTEGER DEFAULT 0,
    follow_username TEXT,
    profile_image_url TEXT,
    name TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  )
`);

    // Indexes for performance
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_parent_path ON nodes(parent_path)`
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_type ON nodes(type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_name ON nodes(name)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_path_type ON nodes(path, type)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_expanded ON nodes(is_expanded)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_user_ui_foreground ON user_ui(is_tab_foreground)`
    );
  }

  // Helper function to parse path and extract name and parent_path
  private parsePathComponents(path: string): {
    name: string;
    parent_path: string | null;
  } {
    if (path === "/") {
      return { name: "/", parent_path: null };
    }

    // Remove leading slash and split
    const parts = path.slice(1).split("/");

    if (parts.length === 1) {
      // Root level like /username
      return { name: parts[0], parent_path: null };
    }

    // Get the last part as name
    const name = parts[parts.length - 1];

    // Get parent path by joining all parts except the last
    const parentParts = parts.slice(0, -1);
    const parent_path = "/" + parentParts.join("/");

    return { name, parent_path };
  }

  // Updated saveContent method with cursor position
  saveContent(
    path: string,
    content: string,
    username: string,
    line: number = 1,
    column: number = 1
  ): void {
    const now = Math.round(Date.now() / 1000);

    // Check if path exists and is a folder - prevent corruption
    const existing = this.sql
      .exec(`SELECT type FROM nodes WHERE path = ?`, path)
      .toArray()[0] as { type: string } | undefined;

    if (existing && existing.type === "folder") {
      throw new Error("Cannot save content to a folder");
    }

    // Ensure parent folders exist first
    this.ensureParentFolders(path, username);

    // Parse path components
    const { name, parent_path } = this.parsePathComponents(path);

    // Insert or update the file with cursor position
    this.sql.exec(
      `
    INSERT OR REPLACE INTO nodes (path, name, parent_path, type, size, content, created_at, updated_at, last_cursor_line, last_cursor_column)
    VALUES (?, ?, ?, 'file', ?, ?, 
      COALESCE((SELECT created_at FROM nodes WHERE path = ?), ?), 
      ?, ?, ?)
  `,
      path,
      name,
      parent_path,
      content.length,
      content,
      path,
      now,
      now,
      line,
      column
    );

    // Update last open path
    this.setUIState(username, { last_open_path: path });
  }

  // Updated ensureParentFolders method
  ensureParentFolders(path: string, username: string): void {
    const parts = path.split("/").filter((p) => p);
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      // -1 because we don't want to create the file itself
      currentPath += "/" + parts[i];

      // Check if folder exists
      const existing = this.sql
        .exec(
          `SELECT id FROM nodes WHERE path = ? AND type = 'folder'`,
          currentPath
        )
        .toArray();

      if (existing.length === 0) {
        // Parse path components for the folder
        const { name, parent_path } = this.parsePathComponents(currentPath);

        // Create folder and expand it
        this.sql.exec(
          `
        INSERT INTO nodes (path, name, parent_path, type, size, content, is_expanded) 
        VALUES (?, ?, ?, 'folder', 0, NULL, TRUE)
      `,
          currentPath,
          name,
          parent_path
        );
      } else {
        // Expand existing folder
        this.sql.exec(
          `
        UPDATE nodes SET is_expanded = TRUE WHERE path = ? AND type = 'folder'
      `,
          currentPath
        );
      }
    }
  }

  createFile(path: string, content: string = "", username: string): void {
    // Check if path already exists
    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, path)
      .toArray()[0];

    if (existing) {
      throw new Error("File already exists");
    }

    this.saveContent(path, content, username);
  }

  createFolder(path: string, username: string): void {
    // Check if path already exists
    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, path)
      .toArray()[0];

    if (existing) {
      throw new Error("Folder already exists");
    }

    // Ensure parent folders exist first
    this.ensureParentFolders(path, username);
    const { name, parent_path } = this.parsePathComponents(path);

    this.sql.exec(
      `
      INSERT INTO nodes (path, name, parent_path, type, size, content, is_expanded) 
      VALUES (?, ?, ?, 'folder', 0, NULL, TRUE)
    `,
      path,
      name,
      parent_path
    );
  }

  copyNode(sourcePath: string, targetPath: string, username: string): void {
    const sourceNode = this.sql
      .exec(`SELECT * FROM nodes WHERE path = ?`, sourcePath)
      .toArray()[0] as FileNode;

    if (!sourceNode) {
      throw new Error("Source node not found");
    }

    if (sourceNode.type === "file") {
      this.createFile(targetPath, sourceNode.content || "", username);
    } else {
      this.createFolder(targetPath, username);
      // Copy all children
      const children = this.sql
        .exec(`SELECT * FROM nodes WHERE path LIKE ? || '/%'`, sourcePath)
        .toArray() as FileNode[];
      for (const child of children) {
        const relativePath = child.path.slice(sourcePath.length);
        const newChildPath = targetPath + relativePath;
        this.copyNode(child.path, newChildPath, username);
      }
    }
  }

  moveNode(sourcePath: string, targetPath: string): void {
    // Get the source node
    const sourceNode = this.sql
      .exec(`SELECT * FROM nodes WHERE path = ?`, sourcePath)
      .toArray()[0] as FileNode;

    if (!sourceNode) {
      throw new Error("Source node not found");
    }

    // Check if target already exists
    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, targetPath)
      .toArray()[0];

    if (existing) {
      throw new Error("Target path already exists");
    }

    // Parse new path components
    const { name, parent_path } = this.parsePathComponents(targetPath);

    // Update the node itself
    this.sql.exec(
      `UPDATE nodes SET path = ?, name = ?, parent_path = ?, updated_at = strftime('%s', 'now') WHERE path = ?`,
      targetPath,
      name,
      parent_path,
      sourcePath
    );

    // Update all children paths if it's a folder
    if (sourceNode.type === "folder") {
      const children = this.sql
        .exec(`SELECT path FROM nodes WHERE path LIKE ? || '/%'`, sourcePath)
        .toArray() as { path: string }[];

      for (const child of children) {
        const relativePath = child.path.slice(sourcePath.length);
        const newChildPath = targetPath + relativePath;
        const { name: childName, parent_path: childParentPath } =
          this.parsePathComponents(newChildPath);

        this.sql.exec(
          `UPDATE nodes SET path = ?, name = ?, parent_path = ?, updated_at = strftime('%s', 'now') WHERE path = ?`,
          newChildPath,
          childName,
          childParentPath,
          child.path
        );
      }
    }
  }

  renameNode(oldPath: string, newName: string): void {
    const node = this.sql
      .exec(`SELECT * FROM nodes WHERE path = ?`, oldPath)
      .toArray()[0] as FileNode;

    if (!node) {
      throw new Error("Node not found");
    }

    // Calculate new path
    const pathParts = oldPath.split("/");
    pathParts[pathParts.length - 1] = newName;
    const newPath = pathParts.join("/");

    // Check if new path already exists
    const existing = this.sql
      .exec(`SELECT id FROM nodes WHERE path = ?`, newPath)
      .toArray()[0];

    if (existing) {
      throw new Error("A file or folder with this name already exists");
    }

    // Use move logic to handle the rename
    this.moveNode(oldPath, newPath);
  }

  getNextAvailableName(basePath: string, extension: string = ""): string {
    let counter = 1;
    let testPath = basePath;

    while (true) {
      const existing = this.sql
        .exec(`SELECT id FROM nodes WHERE path = ?`, testPath)
        .toArray()[0];

      if (!existing) {
        return testPath;
      }

      if (extension) {
        const baseWithoutExt = basePath.slice(0, -extension.length);
        testPath = `${baseWithoutExt}${counter}${extension}`;
      } else {
        testPath = `${basePath}${counter}`;
      }
      counter++;
    }
  }

  deleteNode(path: string): boolean {
    // Delete the node and all its children
    const result = this.sql.exec(
      `
      DELETE FROM nodes 
      WHERE path = ? OR path LIKE ? || '/%'
    `,
      path,
      path
    );
    return result.rowsWritten > 0;
  }

  getVisibleNodes(username: string): VisibleNode[] {
    // First, get all expanded folders
    const folders = this.sql
      .exec(
        `
      SELECT path FROM nodes 
      WHERE type = 'folder' AND is_expanded = TRUE AND path LIKE ?
      ORDER BY path
    `,
        `/${username}/%`
      )
      .toArray() as { path: string }[];

    const expandedFolders = folders.map((f) => f.path);

    // Always include root level
    const rootCondition = `parent_path IS NULL OR parent_path = '/${username}'`;

    // Build condition for children of expanded folders
    let visibleCondition = rootCondition;
    if (expandedFolders.length > 0) {
      const expandedPlaceholders = expandedFolders.map(() => "?").join(",");
      visibleCondition += ` OR parent_path IN (${expandedPlaceholders})`;
    }

    const query = `
      SELECT path,parent_path,type,name,is_expanded FROM nodes 
      WHERE (path LIKE ? OR path = ?) AND (${visibleCondition})
      ORDER BY parent_path, type DESC, name ASC
    `;

    const params = [`/${username}/%`, `/${username}`, ...expandedFolders];
    const nodes = this.sql.exec<VisibleNode>(query, ...params).toArray();

    return nodes;
  }

  toggleExpansion(path: string): void {
    this.sql.exec(
      `
      UPDATE nodes 
      SET is_expanded = NOT is_expanded, updated_at = strftime('%s', 'now')
      WHERE path = ? AND type = 'folder'
    `,
      path
    );
  }

  getUIState(username: string): UIState {
    const result = this.sql
      .exec(`SELECT * FROM user_ui WHERE username = ?`, username)
      .toArray()[0] as UIState | undefined;

    return (
      result || {
        username,
        explorer_scroll_top_path: null,
        last_open_path: null,
        is_tab_foreground: 0,
        follow_username: null,
        profile_image_url: null,
        name: null,
        updated_at: 0,
      }
    );
  }

  handleFollowRedirect(username: string, targetPath: string) {
    // Get all users who are following this username
    const followers = this.sql
      .exec(`SELECT username FROM user_ui WHERE follow_username = ?`, username)
      .toArray() as { username: string }[];

    // Update their last_open_path to match the followed user
    for (const follower of followers) {
      this.setUIState(follower.username, {
        last_open_path: targetPath,
        is_tab_foreground: 1,
      });
    }
  }

  setUIState(username: string, ui_state: Partial<UIState>): void {
    const current = this.getUIState(username);
    const merged = { ...current, ...ui_state };

    this.sql.exec(
      `
    INSERT OR REPLACE INTO user_ui (username, explorer_scroll_top_path, last_open_path, is_tab_foreground, follow_username, profile_image_url, name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
  `,
      username,
      merged.explorer_scroll_top_path || null,
      merged.last_open_path || null,
      merged.is_tab_foreground || 0,
      merged.follow_username || null,
      merged.profile_image_url || null,
      merged.name || null
    );
  }

  async getUserFromToken(token: string): Promise<XUser> {
    const anonymous: XUser = {
      username: "anonymous",
      id: "0",
      name: "Anonymous",
      verified: false,
      // TODO: get this
      profile_image_url: "/anonymous.png",
    };
    if (!token) return anonymous;
    const user = await this.env.KV.get<XUser>(
      `v2:token:${decodeURIComponent(token)}`,
      "json"
    );
    return user || anonymous;
  }

  generateLlmsTxt(username: string): string {
    const files = this.sql
      .exec(
        `
      SELECT path, content, created_at, updated_at FROM nodes 
      WHERE path LIKE ? AND type = 'file'
    `,
        `/${username}/%`
      )
      .toArray() as FileNode[];

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

  renderExplorerHTML(explorerData: ExplorerData, currentPath: string): string {
    const { visible_nodes, pathViewers } = explorerData;

    if (visible_nodes.length === 0) {
      return '<div class="no-files">No files found</div>';
    }

    const renderNode = (node: VisibleNode, level: number = 0): string => {
      const isActive = node.path === currentPath;
      const indent = level * 20;
      const icon = node.type === "folder" ? "" : "📄";

      const expandButton =
        node.type === "folder"
          ? `<button class="expand-btn" onclick="toggleExpansion('${
              node.path
            }')" data-path="${node.path}">
          ${node.is_expanded ? chevronDownSvg : chevronRightSvg}
        </button>`
          : "";

      // Get viewers for this path
      const viewers = pathViewers[node.path] || [];
      const viewerAvatars = viewers
        .slice(0, 3)
        .map(
          (viewer) =>
            `<img src="${viewer.profile_image_url.replace(
              "_400x400",
              "_normal"
            )}" alt="${viewer.name}" title="${
              viewer.name
            }" class="viewer-avatar" crossorigin="anonymous" />`
        )
        .join("");

      return `
        <div class="explorer-item ${isActive ? "active" : ""} ${node.type}" 
             data-path="${node.path}" 
             data-type="${node.type}"
             style="padding-left: ${indent + 10}px"
             onclick="handleExplorerClick('${node.path}', '${node.type}')"
             oncontextmenu="event.preventDefault(); showContextMenu(event, '${
               node.path
             }', '${node.type}')">
          ${expandButton}
          <span class="explorer-icon">${icon}</span>
          <span class="explorer-name">${this.escapeHtml(node.name)}</span>
          <span class="viewer-avatars">${viewerAvatars}${
        viewers.length > 3 ? `+${viewers.length - 3}` : ""
      }</span>
        </div>
      `;
    };

    // Build hierarchical structure
    const nodesByPath = new Map<string, VisibleNode>();
    const nodesByParent = new Map<string | null, VisibleNode[]>();

    visible_nodes.forEach((node) => {
      nodesByPath.set(node.path, node);

      if (!nodesByParent.has(node.parent_path)) {
        nodesByParent.set(node.parent_path, []);
      }
      nodesByParent.get(node.parent_path)!.push(node);
    });

    const renderChildren = (
      parentPath: string | null,
      level: number = 0
    ): string => {
      const children = nodesByParent.get(parentPath) || [];
      return children
        .sort((a, b) => {
          // Folders first, then files
          if (a.type !== b.type) {
            return a.type === "folder" ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        })
        .map((node) => {
          let html = renderNode(node, level);
          if (node.type === "folder" && node.is_expanded) {
            html += renderChildren(node.path, level + 1);
          }
          return html;
        })
        .join("");
    };

    const username = visible_nodes[0]?.path.split("/")[1] || "";
    return renderChildren(`/${username}`, 0);
  }

  escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = this.env.ENVIRONMENT === "development";
    const pathSegments = url.pathname.split("/").filter((p) => p);
    const firstSegment = pathSegments[0] || "default";
    const isRoot = pathSegments.length === 1;

    const token = request.headers
      .get("Cookie")
      ?.split(";")
      .find((r) => r.includes("x_access_token"))
      ?.split("=")[1];
    const user = await this.getUserFromToken(token || "");
    const { username } = user;
    const isAdmin = firstSegment === username || firstSegment === "anonymous";

    // Handle API endpoints - moved to /__api/* pattern
    if (pathSegments.length >= 2 && pathSegments[1] === "__api") {
      return this.handleAPIRequest(request, url, username, firstSegment);
    }

    // Handle expansion/collapse via query params
    const expand = url.searchParams.get("expand");
    const unexpand = url.searchParams.get("unexpand");

    if (expand && isAdmin) {
      this.toggleExpansion(expand);
      // Redirect to same path without query params
      return new Response(null, {
        status: 302,
        headers: { Location: url.pathname },
      });
    }

    if (unexpand && isAdmin) {
      this.toggleExpansion(unexpand);
      return new Response(null, {
        status: 302,
        headers: { Location: url.pathname },
      });
    }

    // Handle llms.txt endpoint
    if (pathSegments.length === 2 && pathSegments[1] === "llms.txt") {
      const llmsTxt = this.generateLlmsTxt(pathSegments[0]);
      return new Response(llmsTxt, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Handle file deletion
    if (request.method === "DELETE" && isAdmin) {
      const deleted = this.deleteNode(url.pathname);
      if (deleted) {
        this.broadcastExplorerUpdate(firstSegment);
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
    let textContent = "";
    let cursorLine = 1;
    let cursorColumn = 1;
    const nodeResult = this.sql
      .exec(
        `SELECT content, type, last_cursor_line, last_cursor_column FROM nodes WHERE path = ?`,
        url.pathname
      )
      .toArray()[0] as
      | {
          content: string;
          type: string;
          last_cursor_line: number;
          last_cursor_column: number;
        }
      | undefined;

    if (nodeResult) {
      if (nodeResult.type === "folder" && url.pathname !== `/${firstSegment}`) {
        // Redirect to prevent editing folders
        return new Response(null, {
          status: 302,
          headers: { Location: `/${firstSegment}` },
        });
      }
      textContent = nodeResult.content || "";
      cursorLine = nodeResult.last_cursor_line || 1;
      cursorColumn = nodeResult.last_cursor_column || 1;
      // Open tab when accessing file
      if (isAdmin) {
        this.setUIState(username, { last_open_path: url.pathname });
      }
    } else if (isAdmin && !isRoot && url.pathname !== `/${firstSegment}`) {
      // Create new file if admin visits non-existent path
      this.createFile(url.pathname, "", firstSegment);
      this.broadcastExplorerUpdate(firstSegment);
      textContent = "";
      this.setUIState(username, { last_open_path: url.pathname });
    }

    if (isRoot) {
      const files = this.sql
        .exec(
          `
        SELECT path, created_at, updated_at FROM nodes 
        WHERE path LIKE ? AND type = 'file'
      `,
          `/${firstSegment}/%`
        )
        .toArray();

      // Check if user has a last open path and redirect there
      if (isAdmin) {
        const uiState = this.getUIState(username);
        if (uiState.last_open_path) {
          const lastFileExists = this.sql
            .exec(
              `SELECT 1 FROM nodes WHERE path = ? AND type = 'file'`,
              uiState.last_open_path
            )
            .toArray()[0];

          if (lastFileExists) {
            return new Response(null, {
              status: 302,
              headers: { Location: uiState.last_open_path },
            });
          }
        }
      }

      textContent = `# Root of ${firstSegment}
          
Go to any subpath of /${firstSegment}/* to start ${
        isAdmin ? "editing" : "watching"
      } a file.

Available files:

${files
  .map(
    (file) =>
      `- [${file.path}](${file.path}) - Created: ${new Date(
        file.created_at as number
      ).toLocaleString()}, Updated: ${new Date(
        file.updated_at as number
      ).toLocaleString()}`
  )
  .join("\n")}
`;
    }

    // WebSocket handling
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(
        request,
        user,
        isAdmin,
        textContent,
        firstSegment,
        cursorLine,
        cursorColumn
      );
    }

    // OAuth endpoints (keeping existing logic)
    if (url.pathname === "/logout") {
      const redirectTo = url.searchParams.get("redirect_to") || "/";
      const isLocalhost = this.env.ENVIRONMENT === "development";
      const securePart = isLocalhost ? "" : " Secure;";
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          "Set-Cookie": `x_access_token=; HttpOnly;${securePart} SameSite=Lax; Max-Age=0; Path=/`,
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
          this.env.X_REDIRECT_URI
        )}&scope=${encodeURIComponent(
          "users.read tweet.read offline.access"
        )}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      });
      const isLocalhost = this.env.ENVIRONMENT === "development";
      const securePart = isLocalhost ? "" : " Secure;";

      headers.append(
        "Set-Cookie",
        `x_oauth_state=${state}; HttpOnly; Path=/;${securePart} SameSite=Lax; Max-Age=600`
      );
      headers.append(
        "Set-Cookie",
        `x_code_verifier=${codeVerifier}; HttpOnly; Path=/;${securePart} SameSite=Lax; Max-Age=600`
      );

      return new Response("Redirecting", { status: 307, headers });
    }

    if (url.pathname === "/callback") {
      return this.handleOAuthCallback(request, url);
    }

    // Return raw content for non-HTML requests
    if (!request.headers.get("accept")?.includes("text/html")) {
      return new Response(textContent || "Not Found", {
        status: textContent === "" ? 404 : 200,
        headers: { "Content-Type": "text/markdown" },
      });
    }

    if (url.pathname === "/") {
      if (username && username !== "anonymous") {
        return new Response(null, {
          status: 302,
          headers: { Location: `/${username}` },
        });
      }

      return new Response(this.renderLandingPage(), {
        headers: { "content-type": "text/html;charset=utf8" },
      });
    }

    this.handleFollowRedirect(username, url.pathname);

    // Prepare data for the main app - now using database-driven approach
    const visible_nodes = this.getVisibleNodes(firstSegment);
    const sessions = this.getRichSessions();
    const pathViewers = this.getPathViewersFromDB(firstSegment);
    const explorerData = {
      visible_nodes,
      sessions,
      pathViewers,
    };

    const uiState = this.getUIState(username);
    const explorerHTML = this.renderExplorerHTML(explorerData, url.pathname);

    return new Response(
      this.renderMainApp(
        user,
        url.pathname,
        firstSegment,
        textContent,
        explorerHTML,
        explorerData,
        uiState,
        isAdmin,
        isLocalhost,
        cursorLine,
        cursorColumn
      ),
      { headers: { "content-type": "text/html;charset=utf8" } }
    );
  }

  async handleAPIRequest(
    request: Request,
    url: URL,
    username: string,
    firstSegment: string
  ): Promise<Response> {
    const pathSegments = url.pathname.split("/").filter((p) => p);
    const apiEndpoint = pathSegments[2]; // after /{username}/__api/

    // Parse request body for endpoints that need it
    let requestData: any = {};
    if (request.method === "POST") {
      try {
        requestData = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (apiEndpoint === "set-follow-username" && request.method === "POST") {
      const { follow_username } = requestData;
      this.setUIState(username, { follow_username });
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (apiEndpoint === "get-follow-username" && request.method === "GET") {
      const uiState = this.getUIState(username);
      return new Response(
        JSON.stringify({ follow_username: uiState.follow_username }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    // Non-admin endpoints (accessible to anyone)
    if (apiEndpoint === "set-scroll-position" && request.method === "POST") {
      const { path } = requestData;
      this.setUIState(username, { explorer_scroll_top_path: path });
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Admin-only endpoints
    const isAdmin = firstSegment === username || firstSegment === "anonymous";
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (apiEndpoint === "create-file" && request.method === "POST") {
      const { path, content = "" } = requestData;
      try {
        this.createFile(path, content, firstSegment);
        this.broadcastExplorerUpdate(firstSegment);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "create-folder" && request.method === "POST") {
      const { path } = requestData;
      try {
        this.createFolder(path, firstSegment);
        this.broadcastExplorerUpdate(firstSegment);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "copy-node" && request.method === "POST") {
      const { sourcePath, targetPath } = requestData;
      try {
        this.copyNode(sourcePath, targetPath, firstSegment);
        this.broadcastExplorerUpdate(firstSegment);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "move-node" && request.method === "POST") {
      const { sourcePath, targetPath } = requestData;
      try {
        this.moveNode(sourcePath, targetPath);
        this.broadcastExplorerUpdate(firstSegment);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "rename-node" && request.method === "POST") {
      const { path, newName } = requestData;
      try {
        this.renameNode(path, newName);
        this.broadcastExplorerUpdate(firstSegment);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    if (apiEndpoint === "delete-node" && request.method === "POST") {
      const { path } = requestData;
      const deleted = this.deleteNode(path);
      if (deleted) {
        this.broadcastExplorerUpdate(firstSegment);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response(JSON.stringify({ error: "Node not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (apiEndpoint === "get-next-name" && request.method === "POST") {
      const { basePath, extension } = requestData;
      const nextName = this.getNextAvailableName(basePath, extension);
      return new Response(JSON.stringify({ nextName }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "API endpoint not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  getRichSessions() {
    const sessions = Array.from(this.sessions.values());
    const usernames = Array.from(new Set(sessions.map((x) => x.username)));

    if (usernames.length === 0) return [];

    const uiStates = this.sql
      .exec<UIState>(
        `SELECT * FROM user_ui WHERE username IN (${usernames
          .map(() => "?")
          .join(",")})`,
        ...usernames
      )
      .toArray();

    const richSessions = sessions.map((session) => {
      const uiState = uiStates.find((x) => x.username === session.username);
      const is_tab_foreground: 0 | 1 =
        session.path === uiState?.last_open_path && uiState?.is_tab_foreground
          ? 1
          : 0;
      return { ...session, is_tab_foreground };
    });
    return richSessions;
  }

  // New method to get pathViewers from database instead of sessions
  getPathViewersFromDB(firstSegment: string): Record<string, Session[]> {
    const pathViewers: Record<string, Session[]> = {};

    // Get all users with foreground tabs and their paths
    const foregroundUsers = this.sql
      .exec<UIState>(
        `SELECT username, last_open_path, profile_image_url, name 
         FROM user_ui 
         WHERE is_tab_foreground = 1 
         AND last_open_path IS NOT NULL 
         AND last_open_path LIKE ?`,
        `/${firstSegment}/%`
      )
      .toArray();

    foregroundUsers.forEach((user) => {
      if (!user.last_open_path) return;

      if (!pathViewers[user.last_open_path]) {
        pathViewers[user.last_open_path] = [];
      }

      // Create a Session-like object from the database data
      pathViewers[user.last_open_path].push({
        username: user.username,
        name: user.name || user.username,
        profile_image_url: user.profile_image_url || "/anonymous.png",
        path: user.last_open_path,
        webSocket: null as any, // Not needed for display
        isAdmin: false, // Not needed for display
        is_tab_foreground: 1,
      });
    });

    return pathViewers;
  }

  // Keep the old method for backward compatibility but mark as deprecated
  /** @deprecated Use getPathViewersFromDB instead */
  getPathViewers(sessions: Session[]): Record<string, Session[]> {
    const pathViewers: Record<string, Session[]> = {};
    sessions.forEach((session) => {
      if (session.is_tab_foreground) {
        if (!pathViewers[session.path]) {
          pathViewers[session.path] = [];
        }
        // Only add unique users per path
        if (
          !pathViewers[session.path].find(
            (s) => s.username === session.username
          )
        ) {
          pathViewers[session.path].push(session);
        }
      }
    });

    return pathViewers;
  }

  handleWebSocket(
    request: Request,
    user: XUser,
    isAdmin: boolean,
    textContent: string,
    firstSegment: string,
    cursorLine: number,
    cursorColumn: number
  ): Response {
    const url = new URL(request.url);
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const { name, profile_image_url, username } = user;
    server.accept();
    const sessionId = crypto.randomUUID();

    this.sessions.set(sessionId, {
      path: url.pathname,
      webSocket: server,
      username,
      name,
      profile_image_url,
      isAdmin,
      is_tab_foreground: 1,
    });

    // Set tab as foreground when opening and store user info in DB
    this.setUIState(username, {
      last_open_path: url.pathname,
      is_tab_foreground: 1,
      profile_image_url,
      name,
    });

    const sessions = this.getRichSessions();
    const visible_nodes = this.getVisibleNodes(firstSegment);
    const pathViewers = this.getPathViewersFromDB(firstSegment);
    const explorer_data = { visible_nodes, sessions, pathViewers };
    const uiState = this.getUIState(firstSegment);

    // when joining, sessions are broadcasted
    this.broadcast(sessionId, {
      type: "join",
      sessionId,
      username,
      path: url.pathname,
      sessionCount: this.sessions.size,
      sessions,
    });

    // when closing, sessions are broadcasted again
    server.addEventListener("close", () => {
      this.sessions.delete(sessionId);
      // Set tab as not foreground when closing
      this.setUIState(username, { is_tab_foreground: 0 });

      const sessions = this.getRichSessions();
      this.broadcast(sessionId, {
        type: "leave",
        sessionId,
        username,
        path: url.pathname,
        sessions,
        sessionCount: this.sessions.size,
      });
      this.broadcastExplorerUpdate(firstSegment);
    });

    server.send(
      JSON.stringify({
        type: "init",
        text: textContent,
        version: this.version,
        sessionId,
        sessionCount: this.sessions.size,
        sessions,
        isAdmin,
        username,
        explorer_data,
        ui_state: uiState,
        line: cursorLine,
        column: cursorColumn,
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
          try {
            this.saveContent(
              url.pathname,
              data.text,
              firstSegment,
              data.line || 1,
              data.column || 1
            );
          } catch (error) {
            // Send error back to client if trying to save to folder
            server.send(
              JSON.stringify({
                type: "error",
                message: "Cannot edit folder content",
              })
            );
            return;
          }
          this.broadcast(
            sessionId,
            {
              type: "text",
              text: data.text,
              version: data.version,
              fromSession: sessionId,
              line: data.line,
              column: data.column,
            },
            url.pathname
          );
          this.broadcastExplorerUpdate(firstSegment);
        } else if (data.type === "delete_file" && isAdmin && data.path) {
          this.deleteNode(data.path);
          this.broadcastExplorerUpdate(firstSegment);
        } else if (data.type === "set_scroll_position" && data.path) {
          this.setUIState(firstSegment, {
            explorer_scroll_top_path: data.path,
          });
        } else if (
          data.type === "cursor_position" &&
          isAdmin &&
          data.line &&
          data.column
        ) {
          // Update cursor position without triggering content save
          this.sql.exec(
            `UPDATE nodes SET last_cursor_line = ?, last_cursor_column = ? WHERE path = ? AND type = 'file'`,
            data.line,
            data.column,
            url.pathname
          );
        } else if (
          data.type === "set_tab_foreground" &&
          data.is_tab_foreground !== undefined
        ) {
          const newPartialState = {
            is_tab_foreground: data.is_tab_foreground,
            last_open_path: url.pathname,
          };
          console.log(
            "handleWebsocket set_tab_foreground",
            username,
            newPartialState
          );
          this.setUIState(username, newPartialState);
          this.broadcastExplorerUpdate(firstSegment);
        }
      } catch (err) {
        console.error("Error:", err);
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleOAuthCallback(request: Request, url: URL): Promise<Response> {
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

    if (!stateCookie || !codeVerifier) {
      return new Response(
        "Cookies weren't set. Likely issue with cookie configuration",
        { status: 400 }
      );
    }

    if (!urlState || urlState !== stateCookie) {
      return new Response("Invalid state", {
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
              `${this.env.X_CLIENT_ID}:${this.env.X_CLIENT_SECRET}`
            )}`,
          },
          body: new URLSearchParams({
            code: code || "",
            redirect_uri: this.env.X_REDIRECT_URI,
            grant_type: "authorization_code",
            code_verifier: codeVerifier,
          }),
        }
      );

      if (!tokenResponse.ok) {
        throw new Error(`Twitter API responded with ${tokenResponse.status}`);
      }

      const { access_token }: TokenResponse = await tokenResponse.json();

      let user: Partial<XUser> = {
        username: `username_${await generateRandomString(7)}`,
      };

      try {
        const userResponse = await fetch(
          "https://api.x.com/2/users/me?user.fields=profile_image_url,verified",
          { headers: { Authorization: `Bearer ${access_token}` } }
        );

        if (userResponse.ok) {
          const userData = await userResponse.json<{ data: XUser }>();
          user = userData.data as XUser;
          user.profile_image_url = user.profile_image_url?.replace(
            "_normal",
            "_400x400"
          );
        }
      } catch (err) {
        console.error("Failed to fetch user info:", err);
      }

      await this.env.KV.put(`v2:token:${access_token}`, JSON.stringify(user));

      const headers = new Headers({
        Location: url.searchParams.get("redirect") || "/" + user.username,
      });
      const isLocalhost = this.env.ENVIRONMENT === "development";
      const securePart = isLocalhost ? "" : " Secure;";

      headers.append(
        "Set-Cookie",
        `x_access_token=${encodeURIComponent(
          access_token
        )}; HttpOnly; Path=/;${securePart} SameSite=Lax; Max-Age=34560000`
      );
      headers.append("Set-Cookie", `x_oauth_state=; Max-Age=0`);
      headers.append("Set-Cookie", `x_code_verifier=; Max-Age=0`);

      return new Response("Redirecting", { status: 307, headers });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return new Response(`Login failed: ${errorMessage}`, { status: 500 });
    }
  }

  renderLandingPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XYText</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; text-align: center; }
        h1 { color: #333; }
        .btn { background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 10px 0; }
        .btn:hover { background: #0056b3; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Your Agent-Friendly Editor in the Cloud</h1>
        <p>Works best in Chromium-based browsers</p>
        <a href="/login" class="btn">Login with X</a>
    </div>
</body>
</html>`;
  }

  renderMainApp(
    user: XUser,
    currentPath: string,
    username: string,
    textContent: string,
    explorerHTML: string,
    explorerData: ExplorerData,
    uiState: UIState,
    isAdmin: boolean,
    isLocalhost: boolean,
    cursorLine: number,
    cursorColumn: number
  ): string {
    const imageUrls = Array.from(
      new Set(
        explorerData.sessions
          .map((x) => x.profile_image_url)
          .map((url) => [url, url.replace("_400x400", "_normal")])
          .flat()
      )
    );

    // Get unique users from sessions
    const uniqueUsers = Array.from(
      new Map(explorerData.sessions.map((s) => [s.username, s])).values()
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
${imageUrls
  .map(
    (url) =>
      `    <link rel="preload" as="image" href="${url}" crossorigin="anonymous">`
  )
  .join("\n")}
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${currentPath.split("/").pop()}</title>
    <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="shortcut icon" href="/favicon.ico" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-title" content="MyWebSite" />
    <link rel="manifest" href="/site.webmanifest" />

    <style>
        * { 
            box-sizing: border-box; 
        }
        
        :root {
            --bg-color: #ffffff;
            --text-color: #24292e;
            --border-color: #e1e4e8;
            --tabs-bg: #f6f8fa;
            --tab-bg: #f6f8fa;
            --tab-active-bg: #ffffff;
            --tab-hover-bg: #e1e4e8;
            --explorer-bg: #f6f8fa;
            --explorer-header-bg: #e1e4e8;
            --explorer-item-hover: #e1e4e8;
            --explorer-item-active: #0969da;
            --status-bar-bg: #0969da;
            --context-menu-bg: #ffffff;
            --context-menu-border: #e1e4e8;
            --context-menu-hover: #f6f8fa;
            --danger-color: #cf222e;
            --danger-hover: #f6f8fa;
            --editor-bg: #ffffff;
        }
        
        @media (prefers-color-scheme: dark) {
            :root {
                --bg-color: #0d1117;
                --text-color: #e6edf3;
                --border-color: #30363d;
                --tabs-bg: #161b22;
                --tab-bg: #21262d;
                --tab-active-bg: #0d1117;
                --tab-hover-bg: #30363d;
                --explorer-bg: #161b22;
                --explorer-header-bg: #21262d;
                --explorer-item-hover: #21262d;
                --explorer-item-active: #1f6feb;
                --status-bar-bg: #1f6feb;
                --context-menu-bg: #161b22;
                --context-menu-border: #30363d;
                --context-menu-hover: #21262d;
                --danger-color: #f85149;
                --danger-hover: #21262d;
                --editor-bg: #0d1117;
            }
        }
        
        body {
            margin: 0; 
            padding: 0; 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            height: 100vh; 
            overflow: hidden; 
            transition: background-color 0.3s ease, color 0.3s ease;
            background-color: var(--bg-color); 
            color: var(--text-color);
        }
        
        .vscode-layout {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        
        .main-content {
            flex: 1;
            display: flex;
            overflow: hidden;
        }
        
        .editor-container {
            flex: 1;
            position: relative;
            min-width: 400px;
            background-color: var(--editor-bg);
        }
        
        .explorer-container {
            width: 300px;
            background: var(--explorer-bg);
            border-left: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            resize: horizontal;
            min-width: 200px;
            max-width: 500px;
        }
        
        .explorer-header {
            background: var(--explorer-header-bg);
            color: var(--text-color);
            padding: 12px 16px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .explorer-content {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
            display: flex;
            flex-direction: column;
        }
        
        .explorer-files {
            flex: 1;
        }
        
        .users-section {
            border-top: 1px solid var(--border-color);
            padding: 16px;
        }
        
        .users-section h3 {
            margin: 0 0 12px 0;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-color);
            opacity: 0.8;
        }
        
        .user-item {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            padding: 4px 0;
        }
        
        .user-avatar-large {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            cursor: pointer;
        }
        
        .user-info {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        
        .user-name {
            font-size: 13px;
            font-weight: 500;
            color: var(--text-color);
            cursor: pointer;
            text-decoration: none;
        }
        
        .user-name:hover {
            text-decoration: underline;
        }
        
        .user-username {
            font-size: 11px;
            color: var(--text-color);
            opacity: 0.6;
        }
        
        .follow-btn {
            font-size: 11px;
            padding: 4px 8px;
            border: 1px solid var(--border-color);
            background: var(--bg-color);
            color: var(--text-color);
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .follow-btn:hover {
            background: var(--explorer-item-hover);
        }
        
        .follow-btn.following {
            background: var(--explorer-item-active);
            color: white;
            border-color: var(--explorer-item-active);
        }
        
        .explorer-item {
            display: flex;
            align-items: center;
            padding: 4px 16px;
            cursor: pointer;
            font-size: 13px;
            line-height: 20px;
            white-space: nowrap;
            color: var(--text-color);
            /* Prevent text selection */
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
            user-select: none;
            transition: background-color 0.2s ease;
        }
        
        .explorer-item:hover {
            background: var(--explorer-item-hover);
        }
        
        .explorer-item.active {
            background: var(--explorer-item-active);
            color: #ffffff;
        }
        
        .explorer-item.folder {
            font-weight: 500;
        }
        
        .expand-btn {
            background: none;
            border: none;
            color: var(--text-color);
            cursor: pointer;
            padding: 0;
            margin-right: 6px;
            font-size: 10px;
            width: 16px;
            text-align: center;
            transition: color 0.2s ease;
        }
        
        .expand-btn:hover {
            color: var(--text-color);
            opacity: 0.8;
        }
        
        .explorer-icon {
            margin-right: 8px;
            font-size: 16px;
        }
        
        .explorer-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .viewer-avatars {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-left: 8px;
        }
        
        .viewer-avatar {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            border: 1px solid var(--border-color);
        }
        
        .status-bar {
            background: var(--status-bar-bg);
            color: #ffffff;
            padding: 4px 16px;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 22px;
        }
        
        .no-files {
            padding: 20px;
            text-align: center;
            color: var(--text-color);
            opacity: 0.7;
            font-style: italic;
            font-size: 13px;
        }
        
        .btn {
            color: #ffffff;
            cursor: pointer;
            font-size: 12px;
            text-decoration:none;
        }
        
        .btn:hover {
            color: #ccc;
        }
        
        .context-menu {
            position: fixed;
            background: var(--context-menu-bg);
            border: 1px solid var(--context-menu-border);
            border-radius: 6px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            z-index: 10000;
            min-width: 180px;
            display: none;
            overflow: hidden;
        }
        
        .context-menu-item {
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            color: var(--text-color);
            transition: background-color 0.2s ease;
        }
        
        .context-menu-item:hover {
            background: var(--context-menu-hover);
        }
        
        .context-menu-item.danger {
            color: var(--danger-color);
        }
        
        .context-menu-item.danger:hover {
            background: var(--danger-hover);
        }
        
        .context-menu-separator {
            height: 1px;
            background: var(--border-color);
            margin: 4px 0;
        }

        /* Ensure Monaco container matches theme immediately */
        .monaco-editor {
            background-color: var(--editor-bg) !important;
        }
        
        @media (max-width: 768px) {
            .explorer-container {
                width: 250px;
            }
        }
    </style>
</head>
<body>
    <div class="vscode-layout">
     
        <div class="main-content">
            <div class="editor-container" id="editor">
            </div>
            
            <div class="explorer-container">
                <div class="explorer-header">Explorer</div>
                <div class="explorer-content" id="explorerContent">
                    <div class="explorer-files">
                        ${explorerHTML}
                    </div>
                    
                    <div class="users-section">
                        <h3>Users</h3>
                        ${uniqueUsers
                          .map(
                            (u) => `
                            <div class="user-item">
                                <img src="${u.profile_image_url}" 
                                     alt="${u.name}" 
                                     title="${u.name}" 
                                     crossorigin="anonymous"
                                     class="user-avatar-large" 
                                     onclick="window.open('https://x.com/${
                                       u.username
                                     }', '${u.username}')" />
                                <div class="user-info">
                                    <a href="https://x.com/${u.username}" 
                                       target="${u.username}" 
                                       class="user-name">${u.name}</a>
                                    <span class="user-username">@${
                                      u.username
                                    }</span>
                                </div>
                                ${
                                  user.username !== u.username && false
                                    ? `<button class="follow-btn" 
                                        data-username="${u.username}"
                                        onclick="toggleFollow('${u.username}')">
                                    Follow
                                </button>`
                                    : ""
                                }
                            </div>
                        `
                          )
                          .join("")}
                    </div>
                </div>
            </div>
        </div>
        
        <div class="status-bar">
            <span style="display:flex;flex-direction:row;gap:10px;">
              <span id="connectionStatus">Connected</span>
              <span class="btn" onclick="window.location.href='/logout'">Logout</span>
              <span class="btn" onclick="window.open('https://letmeprompt.com/from/'+window.location.href,'${currentPath}')">Prompt</span>
              <a href="/studio" class="btn" target="studio">Studio</a>
              <span class="btn" onclick="window.open('https://${username}.xytext.com'+window.location.pathname.replace('${username}/',''),'${username}.xytext.com/${currentPath}')">Preview</span>
            </span>
            <span id="cursorInfo">Line ${cursorLine}, Column ${cursorColumn}</span>
        </div>
    </div>

    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item" onclick="copyNode()">Copy</div>
        <div class="context-menu-item" onclick="renameNode()">Rename</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" onclick="newFile()">New File</div>
        <div class="context-menu-item" onclick="newFolder()">New Folder</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item danger" onclick="deleteNode()">Delete</div>
    </div>

    <script src="https://unpkg.com/monaco-editor@0.44.0/min/vs/loader.js"></script>
    <script>
        window.vscodeApp = {
            editor: null,
            ws: null,
            sessionId: null,
            version: 0,
            isAdmin: ${JSON.stringify(isAdmin)},
            username: ${JSON.stringify(username)},
            currentPath: ${JSON.stringify(currentPath)},
            explorerData: ${JSON.stringify(explorerData)},
            uiState: ${JSON.stringify(uiState)},
            sessions: ${JSON.stringify(explorerData.sessions)},
            user: ${JSON.stringify(user)},
            contextMenuTarget: null,
            commandPaletteOpen: false,
            waitingForSecondKey: false,
            firstSegment: ${JSON.stringify(username)},
            
            async init() {
                await this.setupMonaco();
                this.setupWebSocket();
                this.setupEventListeners();
                this.setupScrollTracking();
                this.setupDragAndDrop();
                this.updateFollowButtons();
                this.setupTabVisibility();
                console.log('VSCode app initialized');
            },
            
            setupTabVisibility() {
                // Handle tab visibility changes
                document.addEventListener('visibilitychange', () => {
                    const is_tab_foreground = document.hidden ? 0 : 1;
                    this.setTabForeground(is_tab_foreground);
                });
                
                // Handle window focus/blur
                window.addEventListener('focus', () => {
                    setTimeout(() => {
                        this.setTabForeground(1);
                    }, 10); // 10ms delay to prevent race conditions
                });
                
            },
            
            async setTabForeground(is_tab_foreground) {
                // Update via WebSocket
                console.log("hit setTabForeground", is_tab_foreground);
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    console.log("ws open!",is_tab_foreground);

                    this.ws.send(JSON.stringify({
                        type: 'set_tab_foreground',
                        is_tab_foreground
                    }));
                }
            },
            
            updateFollowButtons() {
                console.log('Updating follow buttons, current uiState:', this.uiState); // Add debugging

                document.querySelectorAll('.follow-btn').forEach(btn => {
                    const username = btn.dataset.username;
                    const isFollowing = this.uiState?.follow_username === username;
                    btn.textContent = isFollowing ? 'Unfollow' : 'Follow';
                    btn.classList.toggle('following', isFollowing);
                });
            },

            
            async setupMonaco() {
                const editorContainer = document.getElementById('editor');
                
                return new Promise((resolve) => {
                    require.config({ paths: { 'vs': 'https://unpkg.com/monaco-editor@0.44.0/min/vs' } });
                    require(['vs/editor/editor.main'], () => {
                        // Determine theme based on system preference
                        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                        const theme = isDark ? 'vs-dark' : 'vs';
                        
                        // Create editor with theme matching system preference
                        this.editor = monaco.editor.create(document.getElementById('editor'), {
                            value: ${JSON.stringify(textContent)},
                            language: 'markdown',
                            theme: theme,
                            automaticLayout: true,
                            wordWrap: 'on',
                            minimap: { enabled: true },
                            fontSize: 14,
                            lineHeight: 22,
                            padding: { top: 16, bottom: 16 },
                            readOnly: !this.isAdmin,
                            scrollBeyondLastLine: false,
                            smoothScrolling: true,
                            cursorBlinking: 'smooth',
                            fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', Monaco, 'Roboto Mono', monospace",
                            fontLigatures: true,
                            renderWhitespace: 'selection',
                            rulers: [80, 120],
                            bracketPairColorization: { enabled: true },
                            guides: { indentation: true, highlightActiveIndentation: true }
                        });
                        
                        // Set cursor position
                        this.editor.setPosition({ lineNumber: ${cursorLine}, column: ${cursorColumn} });
                        
                        // Focus the editor
                        this.editor.focus();
                        
                        // Listen for theme changes
                        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                            monaco.editor.setTheme(e.matches ? 'vs-dark' : 'vs');
                        });
                        
                        // Mark as loaded to hide loading text
                        editorContainer.classList.add('loaded');
                        
                        this.editor.onDidChangeModelContent(() => {
                            if (this.isAdmin) {
                                this.sendContentChange();
                            }
                        });
                        
                        this.editor.onDidChangeCursorPosition((e) => {
                            this.updateCursorInfo();
                            this.sendCursorPosition(e.position.lineNumber, e.position.column);
                        });
                                                
                        resolve();
                    });
                });
            },
            
            setupDragAndDrop() {
                const explorerContent = document.querySelector('.explorer-files');
                let draggedElement = null;
                
                explorerContent.addEventListener('dragstart', (e) => {
                    if (!this.isAdmin) {
                        e.preventDefault();
                        return;
                    }
                    
                    const explorerItem = e.target.closest('.explorer-item');
                    if (explorerItem) {
                        draggedElement = explorerItem;
                        e.dataTransfer.setData('text/plain', explorerItem.dataset.path);
                        e.dataTransfer.effectAllowed = 'move';
                    }
                });
                
                explorerContent.addEventListener('dragover', (e) => {
                    if (!this.isAdmin) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                });
                
                explorerContent.addEventListener('drop', async (e) => {
                    if (!this.isAdmin) return;
                    e.preventDefault();
                    
                    const sourcePath = e.dataTransfer.getData('text/plain');
                    const targetElement = e.target.closest('.explorer-item');
                    
                    if (!targetElement || !sourcePath) return;
                    
                    const targetPath = targetElement.dataset.path;
                    const targetType = targetElement.dataset.type;
                    
                    // Don't drop on self
                    if (sourcePath === targetPath) return;
                    
                    // Calculate new path
                    let newPath;
                    if (targetType === 'folder') {
                        const sourceName = sourcePath.split('/').pop();
                        newPath = targetPath + '/' + sourceName;
                    } else {
                        // Drop on file means drop in same directory
                        const targetDir = targetPath.split('/').slice(0, -1).join('/');
                        const sourceName = sourcePath.split('/').pop();
                        newPath = targetDir + '/' + sourceName;
                    }
                    
                    // Move the node
                    await this.moveNode(sourcePath, newPath);
                });
                
                // Make explorer items draggable
                explorerContent.addEventListener('mousedown', (e) => {
                    const explorerItem = e.target.closest('.explorer-item');
                    if (explorerItem && this.isAdmin) {
                        explorerItem.draggable = true;
                    }
                });
            },
            
            async moveNode(sourcePath, targetPath) {
                const firstSegment = sourcePath.split('/')[1];
                const response = await fetch(\`/\${firstSegment}/__api/move-node\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sourcePath, targetPath })
                });
                
                if (response.ok) {
                    // If we moved the current file, redirect to new location
                    if (sourcePath === this.currentPath) {
                        window.location.href = targetPath;
                    }
                } else {
                    const error = await response.json();
                    alert('Move failed: ' + error.error);
                }
            },
            
            async createNewFile() {
                const fileName = prompt('Enter file name:');
                if (!fileName) return;
                
                const currentDir = this.currentPath.split('/').slice(0, -1).join('/');
                const newFilePath = currentDir + '/' + fileName;
                
                const firstSegment = this.currentPath.split('/')[1];
                const response = await fetch(\`/\${firstSegment}/__api/create-file\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: newFilePath, content: '' })
                });
                
                if (response.ok) {
                    window.location.href = newFilePath;
                } else {
                    const error = await response.json();
                    alert('Create file failed: ' + error.error);
                }
            },
            
            async createNewFolder() {
                const folderName = prompt('Enter folder name:');
                if (!folderName) return;
                
                const currentDir = this.currentPath.split('/').slice(0, -1).join('/');
                const newFolderPath = currentDir + '/' + folderName;
                
                const firstSegment = this.currentPath.split('/')[1];
                const response = await fetch(\`/\${firstSegment}/__api/create-folder\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: newFolderPath })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    alert('Create folder failed: ' + error.error);
                }
            },
            
            setupWebSocket() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = protocol + '//' + window.location.host + this.currentPath;
                this.ws = new WebSocket(wsUrl);
                
                this.ws.onopen = () => {
                    document.getElementById('connectionStatus').textContent = 'Connected';
                };
                
                this.ws.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                };
                
                this.ws.onclose = () => {
                    document.getElementById('connectionStatus').textContent = 'Disconnected';
                    setTimeout(() => this.setupWebSocket(), 1000);
                };
            },
            
            setupEventListeners() {
                document.addEventListener('keydown', (e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'w' && this.editor && this.editor.hasTextFocus()) {
                        e.preventDefault();
                        this.closeCurrentTab();
                    }
                });
                
                document.addEventListener('click', () => {
                    document.getElementById('contextMenu').style.display = 'none';
                });
                
                window.toggleExpansion = (path) => {
                    const expanded = this.explorerData.visible_nodes.find(n => n.path === path)?.is_expanded;
                    const action = expanded ? 'unexpand' : 'expand';
                    const url = new URL(window.location.href);
                    url.searchParams.set(action, path);
                    window.location.href = url.toString();
                };
                
                window.handleExplorerClick = (path, type) => {
                    if (type === 'file') {
                        window.open(path, path).focus();
                        if(this.uiState?.follow_username){
                           window.toggleFollow(this.uiState?.follow_username);
                        }
                    } else if (type === 'folder') {
                        window.toggleExpansion(path);
                    }
                };
                
                window.showContextMenu = (event, path, type) => {
                    if (!this.isAdmin) return;
                    this.contextMenuTarget = { path, type };
                    const menu = document.getElementById('contextMenu');
                    menu.style.display = 'block';
                    menu.style.left = event.pageX + 'px';
                    menu.style.top = event.pageY + 'px';
                };
                
                  window.toggleFollow = async (username) => {
                      const newFollowState = this.uiState?.follow_username === username ? null : username;
                      
                      // Update local state immediately for UI responsiveness
                      this.uiState = { ...this.uiState, follow_username: newFollowState };
                      this.updateFollowButtons(); // Update UI immediately
                      
                      // Update backend
                      const response = await fetch(\`/\${this.firstSegment}/__api/set-follow-username\`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ follow_username: newFollowState })
                      });
                      
                      if (!response.ok) {
                          // Revert local state if backend update failed
                          this.uiState = { ...this.uiState, follow_username: this.uiState?.follow_username === username ? null : username };
                          this.updateFollowButtons();
                          alert('Failed to update follow status');
                      }
                  };

                
                window.copyNode = async () => {
                    if (!this.contextMenuTarget) return;
                    
                    const { path, type } = this.contextMenuTarget;
                    const pathParts = path.split('/');
                    const fileName = pathParts[pathParts.length - 1];
                    
                    let extension = '';
                    if (type === 'file') {
                        const dotIndex = fileName.lastIndexOf('.');
                        if (dotIndex > 0) {
                            extension = fileName.slice(dotIndex);
                        }
                    }
                    
                    // Get next available name
                    const firstSegment = path.split('/')[1];
                    const response = await fetch(\`/\${firstSegment}/__api/get-next-name\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ basePath: path, extension })
                    });
                    
                    if (response.ok) {
                        const { nextName } = await response.json();
                        
                        // Copy the node
                        const copyResponse = await fetch(\`/\${firstSegment}/__api/copy-node\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sourcePath: path, targetPath: nextName })
                        });
                        
                        if (!copyResponse.ok) {
                            const error = await copyResponse.json();
                            alert('Copy failed: ' + error.error);
                        }
                    }
                };
                
                window.renameNode = async () => {
                    if (!this.contextMenuTarget) return;
                    
                    const { path, type } = this.contextMenuTarget;
                    const currentName = path.split('/').pop();
                    const newName = prompt('Enter new name:', currentName);
                    
                    if (!newName || newName === currentName) return;
                    
                    const firstSegment = path.split('/')[1];
                    const response = await fetch(\`/\${firstSegment}/__api/rename-node\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path, newName })
                    });
                    
                    if (response.ok) {
                        // If we renamed the current file, redirect to new location
                        if (path === this.currentPath) {
                            const newPath = path.split('/').slice(0, -1).join('/') + '/' + newName;
                            window.location.href = newPath;
                        }
                    } else {
                        const error = await response.json();
                        alert('Rename failed: ' + error.error);
                    }
                };
                
                window.newFile = async () => {
                    if (!this.contextMenuTarget) return;
                    
                    const fileName = prompt('Enter file name:');
                    if (!fileName) return;
                    
                    const { path, type } = this.contextMenuTarget;
                    const parentPath = type === 'folder' ? path : path.split('/').slice(0, -1).join('/');
                    const newFilePath = parentPath + '/' + fileName;
                    
                    const firstSegment = path.split('/')[1];
                    const response = await fetch(\`/\${firstSegment}/__api/create-file\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: newFilePath, content: '' })
                    });
                    
                    if (response.ok) {
                        window.location.href = newFilePath;
                    } else {
                        const error = await response.json();
                        alert('Create file failed: ' + error.error);
                    }
                };
                
                window.newFolder = async () => {
                    if (!this.contextMenuTarget) return;
                    
                    const folderName = prompt('Enter folder name:');
                    if (!folderName) return;
                    
                    const { path, type } = this.contextMenuTarget;
                    const parentPath = type === 'folder' ? path : path.split('/').slice(0, -1).join('/');
                    const newFolderPath = parentPath + '/' + folderName;
                    
                    const firstSegment = path.split('/')[1];
                    const response = await fetch(\`/\${firstSegment}/__api/create-folder\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: newFolderPath })
                    });
                    
                    if (!response.ok) {
                        const error = await response.json();
                        alert('Create folder failed: ' + error.error);
                    }
                };
                
                window.deleteNode = async () => {
                    if (!this.contextMenuTarget) return;
                    
                    const { path, type } = this.contextMenuTarget;
                    
                    if(type==='folder'){
                        if (!confirm('Are you sure you want to delete this folder?')) return;
                    }
                    
                    const firstSegment = path.split('/')[1];
                    const response = await fetch(\`/\${firstSegment}/__api/delete-node\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path })
                    });
                    
                    if (response.ok) {
                        if (path === this.currentPath) {
                            window.location.href = '/' + firstSegment;
                        }
                    } else {
                        const error = await response.json();
                        alert('Delete failed: ' + error.error);
                    }
                };
            },
            
            
            async closeCurrentTab() {
                if (!this.isAdmin) return;
                const firstSegment = this.currentPath.split('/')[1];
                const response = await fetch(\`/\${firstSegment}/__api/close-tab\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: this.currentPath })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    window.location.href = result.nextPath;
                }
            },
            
            
            setupScrollTracking() {
                const explorerFiles = document.querySelector('.explorer-files');
                let scrollTimeout;
                
                explorerFiles.addEventListener('scroll', () => {
                    clearTimeout(scrollTimeout);
                    scrollTimeout = setTimeout(() => {
                        const scrollTop = explorerFiles.scrollTop;
                        const items = explorerFiles.querySelectorAll('.explorer-item');
                        
                        for (let item of items) {
                            if (item.offsetTop >= scrollTop) {
                                const path = item.getAttribute('data-path');
                                this.setScrollPosition(path);
                                break;
                            }
                        }
                    }, 150);
                });
            },
            
            async setScrollPosition(path) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'set_scroll_position',
                        path: path
                    }));
                }
            },
            
            sendContentChange() {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this._settingFromWebSocket) return;

                this.version++;
                const position = this.editor.getPosition();
                this.ws.send(JSON.stringify({
                    type: 'text',
                    text: this.editor.getValue(),
                    version: this.version,
                    line: position.lineNumber,
                    column: position.column
                }));
            },
            
            sendCursorPosition(line, column) {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAdmin) return;
                this.ws.send(JSON.stringify({
                    type: 'cursor_position',
                    line: line,
                    column: column
                }));
            },
                      
          handleMessage(message) {
              switch (message.type) {
                  case 'join':
                      console.log(message.username + ' has opened ' + message.path+ '; now ' + message.sessionCount + ' open sessions');
                      this.sessions = message.sessions || this.sessions;
                      this.followIfFollowing(); // Check for follow redirect
                      break;
                  case 'leave':
                      console.log(message.username + ' has closed ' + message.path + '; now ' + message.sessionCount + ' open sessions');
                      this.sessions = message.sessions || this.sessions;
                      break;
                  
                  case 'init':
                      this.sessionId = message.sessionId;
                      this.version = message.version;
                      this.explorerData = message.explorer_data;
                      this.uiState = message.ui_state;
                      this.sessions = message.sessions;
                      this.followIfFollowing();
                      console.log("got init")
                      // Only update explorer on init, not the entire UI
                      this.renderExplorer();
                      this.updateFollowButtons();
                      break;

                    case 'text':
                        if (message.fromSession !== this.sessionId) {
                            const position = this.editor.getPosition();
                            // IMPORTANT: Temporarily disable the content change listener
                            // to prevent broadcast loops when setting content from WebSocket
                            this._settingFromWebSocket = true;
                            
                            this.editor.setValue(message.text);
                            this.version = message.version;
                            
                            if (this.isAdmin) {
                                this.editor.setPosition(position);
                            }
                            
                            // Re-enable after a short delay to ensure setValue has completed
                            setTimeout(() => {
                                this._settingFromWebSocket = false;
                            }, 10);
                        }
                        break;
                    case 'explorer_update':
                        console.log("got explorer_update")
                        this.explorerData = message.explorer_data;
                        this.sessions = message.explorer_data?.sessions || this.sessions;
                        this.followIfFollowing(); // Check for follow redirect on updates
                        this.updateUI();
                        break;
                    case 'error':
                        alert(message.message);
                        break;
                }
            },
            
            updateUI() {                
                // Update explorer
                const explorerFiles = document.querySelector('.explorer-files');
                if (explorerFiles) {
                    this.renderExplorer();
                }
                
                // Update users section
                this.updateUsersSection();
            },

            followIfFollowing() {
                if (!this.uiState?.follow_username) return;
                
                const followedSession = this.sessions.find(s => 
                    s.is_tab_foreground && this.uiState.follow_username === s.username
                );
                
                if (followedSession && followedSession.path !== this.currentPath) {
                    console.log(\`Following \${this.uiState.follow_username} to \${followedSession.path}\`);
                    // Use replace instead of href to avoid adding to history
                    window.location.replace(followedSession.path);
                }
            },

                        
            updateUsersSection() {
                const uniqueUsers = Array.from(
                    new Map(this.sessions.map(s => [s.username, s])).values()
                );
                
                const usersSection = document.querySelector('.users-section');
                if (!usersSection) return;
                
                // Check if we need to update - compare user lists
                const existingUsers = Array.from(usersSection.querySelectorAll('.user-item')).map(item => {
                    const img = item.querySelector('.user-avatar-large');
                    return img ? img.alt : null;
                }).filter(Boolean);
                
                const newUsers = uniqueUsers.map(u => u.name);
                
                // Only re-render if users actually changed
                if (JSON.stringify(existingUsers.sort()) === JSON.stringify(newUsers.sort())) {
                    this.updateFollowButtons(); // Just update buttons, don't re-render images
                    return;
                }
                
                const usersHTML = \`
                    <h3>Users</h3>
                    \${uniqueUsers.map(user => \`
                        <div class="user-item">
                            <img src="\${user.profile_image_url}" 
                                alt="\${user.name}" 
                                title="\${user.name}" 
                                crossorigin="anonymous"
                                class="user-avatar-large" 
                                onclick="window.open('https://x.com/\${user.username}', '\${user.username}')" />
                            <div class="user-info">
                                <a href="https://x.com/\${user.username}" 
                                  target="\${user.username}" 
                                  class="user-name">\${user.name}</a>
                                <span class="user-username">@\${user.username}</span>
                            </div>
                            \${user.username !== window.vscodeApp.user.username && false ? \`<button class="follow-btn" 
                                    data-username="\${user.username}"
                                    onclick="toggleFollow('\${user.username}')">
                                Follow
                            </button>\`:''}
                        </div>
                    \`).join('')}
                \`;
                
                usersSection.innerHTML = usersHTML;
                this.updateFollowButtons();
            },


            renderExplorer() {
                const explorerFiles = document.querySelector('.explorer-files');
                if (!explorerFiles || !this.explorerData) return;
                
                const { visible_nodes, pathViewers } = this.explorerData;
                
                if (visible_nodes.length === 0) {
                    explorerFiles.innerHTML = '<div class="no-files">No files found</div>';
                    return;
                }
                
                const renderNode = (node, level = 0) => {
                    const isActive = node.path === this.currentPath;
                    const indent = level * 20;
                    const icon = node.type === 'folder' ? '' : '📄';
                    const chevronDownSvg = ${JSON.stringify(chevronDownSvg)};
                    const chevronRightSvg = ${JSON.stringify(chevronRightSvg)};
                    
                    const expandButton = node.type === 'folder' ? 
                        \`<button class="expand-btn" onclick="toggleExpansion('\${node.path}')" data-path="\${node.path}">
                            \${node.is_expanded ? chevronDownSvg : chevronRightSvg}
                        </button>\` : '';
                    
                    // Get viewers for this path
                    const viewers = pathViewers[node.path] || [];
                    const viewerAvatars = viewers.slice(0,3)
                        .map(viewer => 
                            \`<img src="\${viewer.profile_image_url.replace('_400x400', '_normal')}" 
                                  alt="\${viewer.name}" 
                                  crossorigin="anonymous"
                                  title="\${viewer.name}" 
                                  class="viewer-avatar" />\`)
                        .join('');
                    
                    return \`
                        <div class="explorer-item \${isActive ? 'active' : ''} \${node.type}" 
                            data-path="\${node.path}" 
                            data-type="\${node.type}"
                            style="padding-left: \${indent + 10}px"
                            onclick="handleExplorerClick('\${node.path}', '\${node.type}')"
                            oncontextmenu="event.preventDefault(); showContextMenu(event, '\${node.path}', '\${node.type}')">
                            \${expandButton}
                            <span class="explorer-icon">\${icon}</span>
                            <span class="explorer-name">\${this.escapeHtml(node.name)}</span>
                            <span class="viewer-avatars">\${viewerAvatars}\${viewers.length > 3 ? \`+\${viewers.length-3}\`:''}</span>
                        </div>
                    \`;
                };
                
                // Build hierarchical structure
                const nodesByPath = new Map();
                const nodesByParent = new Map();
                
                visible_nodes.forEach(node => {
                    nodesByPath.set(node.path, node);
                    
                    if (!nodesByParent.has(node.parent_path)) {
                        nodesByParent.set(node.parent_path, []);
                    }
                    nodesByParent.get(node.parent_path).push(node);
                });
                
                const renderChildren = (parentPath, level = 0) => {
                    const children = nodesByParent.get(parentPath) || [];
                    return children
                        .sort((a, b) => {
                            // Folders first, then files
                            if (a.type !== b.type) {
                                return a.type === 'folder' ? -1 : 1;
                            }
                            return a.name.localeCompare(b.name);
                        })
                        .map(node => {
                            let html = renderNode(node, level);
                            if (node.type === 'folder' && node.is_expanded) {
                                html += renderChildren(node.path, level + 1);
                            }
                            return html;
                        })
                        .join('');
                };
                
                const username = visible_nodes[0]?.path.split('/')[1] || '';
                explorerFiles.innerHTML = renderChildren(\`/\${username}\`, 0);
            },

            escapeHtml(text) {
                return text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            },
            
            updateCursorInfo() {
                if (!this.editor) return;
                const position = this.editor.getPosition();
                const selection = this.editor.getSelection();
                
                let text = \`Line \${position.lineNumber}, Column \${position.column}\`;
                if (!selection.isEmpty()) {
                    const selectedText = this.editor.getModel().getValueInRange(selection);
                    text += \` • \${selectedText.length} chars selected\`;
                }
                
                document.getElementById('cursorInfo').textContent = text;
            }
        };
        
        // Initialize when DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                window.vscodeApp.init();
            });
        } else {
            window.vscodeApp.init();
        }
    </script>
</body>
</html>`;
  }
  /** broadcast information to all sessions or sessions at a given path */
  broadcast(senderSessionId: string, message: WSMessage, path?: string): void {
    const messageStr = JSON.stringify(message);
    //@ts-ignore
    for (const [sessionId, session] of this.sessions.entries()) {
      if (sessionId !== senderSessionId) {
        if (!path || (path && session.path === path)) {
          try {
            session.webSocket.send(messageStr);
          } catch (err) {
            this.sessions.delete(sessionId);
          }
        }
      }
    }
  }

  broadcastExplorerUpdate(firstSegment: string): void {
    const visible_nodes = this.getVisibleNodes(firstSegment);
    const sessions = this.getRichSessions();
    const pathViewers = this.getPathViewersFromDB(firstSegment);

    const message: WSMessage = {
      type: "explorer_update",
      explorer_data: { visible_nodes, sessions, pathViewers },
    };
    const messageStr = JSON.stringify(message);
    //@ts-ignore
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        session.webSocket.send(messageStr);
      } catch (err) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

const getLoggedStub = async (request: Request, env: Env) => {
  const token =
    request.headers
      .get("Cookie")
      ?.split(";")
      .find((r) => r.includes("x_access_token"))
      ?.split("=")[1] ||
    request.headers.get("Authorization")?.slice("Bearer ".length);
  if (!token) {
    return;
  }
  const user = token
    ? await env.KV.get<XUser>(`v2:token:${decodeURIComponent(token)}`, "json")
    : null;
  if (!user) {
    return;
  }
  const stub = env.TEXT.get(env.TEXT.idFromName(user.username + ":v14"));
  return stub;
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/studio") {
      const stub = await getLoggedStub(request, env);
      if (!stub) {
        return new Response("Unauthorized", { status: 401 });
      }
      return studioMiddleware(request, stub.raw, {
        dangerouslyDisableAuth: true,
      });
    }
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
    const username = url.pathname.split("/")[1];
    const stub = env.TEXT.get(env.TEXT.idFromName(username + ":v14"));
    return stub.fetch(request);
  },
};
