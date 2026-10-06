/**
 * Web 远程控制的工作区与任务数据源。
 *
 * 手机 SPA 首页的工作区列表与任务计数来自控制面 payload（bootstrap-response /
 * workspace-list-response / workspace-list-updated），不走 bridge 后的 RPC 通道；
 * 这里提供真实数据：工作区取 main 的窗口工作区注册表（windowWorkspaceMap），
 * 任务直接只读查询 ~/.zcode/v2/tasks-index.sqlite（与 host 共库，WAL 并发只读）。
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { BrowserWindow } from "electron";

let resolveOpenWorkspacePaths: (() => string[]) | null = null;

/** index.ts 注入窗口工作区注册表快照（windowWorkspaceMap 扁平化）。 */
export function setWebRemoteControlWorkspaceResolver(resolver: () => string[]): void {
  resolveOpenWorkspacePaths = resolver;
}

/** 旧版 ul()：路径最后一段作为展示 label。 */
export function workspaceLabel(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function getWorkspaces(): Record<string, unknown>[] {
  const paths = [...new Set(resolveOpenWorkspacePaths?.() ?? [])].filter(Boolean);
  if (paths.length === 0 && BrowserWindow.getAllWindows().length > 0) {
    paths.push(join(homedir(), ".zcode", "workspace", "default"));
  }
  return paths.map((workspacePath) => ({
    kind: "local",
    workspacePath,
    label: workspaceLabel(workspacePath),
    connectionState: "connected",
  }));
}

// node:sqlite 需走 createRequire（tsup 会把动态 import 改写成 import("sqlite")），
// 与 chromeCookieManager.ts 同一模式。
const nodeRequire = createRequire(import.meta.url);
let sqliteModule: typeof import("node:sqlite") | null = null;
function getSqlite(): typeof import("node:sqlite") | null {
  if (sqliteModule) return sqliteModule;
  try {
    sqliteModule = nodeRequire("node:sqlite") as typeof import("node:sqlite");
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function mapDisplayStatus(status: string | null): "idle" | "running" | "completed" | "error" {
  if (status === "running" || status === "completed" || status === "error") return status;
  return "idle";
}

/**
 * 只读查询 tasks-index 的任务（SPA og schema 形态）。
 * 任何失败回退空列表，不影响远控主链路。
 */
function readIndexedTasks(limit = 200): Array<Record<string, unknown>> {
  const sqlite = getSqlite();
  if (!sqlite) return [];
  const dbPath = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
  if (!existsSync(dbPath)) return [];
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const statement = db.prepare(
      "SELECT workspace_path, task_id, title, provider, created_at, updated_at, unread_at, pinned, archived, task_status FROM tasks WHERE deleted = 0 ORDER BY updated_at DESC LIMIT ?",
    );
    const rows = statement.all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const workspacePath = String(row.workspace_path);
      const unreadAt = row.unread_at;
      return {
        taskId: String(row.task_id),
        title: String(row.title ?? ""),
        workspacePath,
        workspaceLabel: workspaceLabel(workspacePath),
        workspaceKind: "local",
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.provider ? { provider: String(row.provider) } : {}),
        ...(typeof unreadAt === "number" && unreadAt > 0 ? { unreadAt } : {}),
        displayStatus: mapDisplayStatus(row.task_status ? String(row.task_status) : null),
        pinned: row.pinned === 1,
        archived: row.archived === 1,
      };
    });
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

/** 当前工作区列表内的真实任务（SPA 首页任务计数与时间线的数据源）。 */
export function getTasks(): Array<Record<string, unknown>> {
  const workspacePaths = new Set(
    (getWorkspaces() as Array<{ workspacePath?: unknown }>)
      .map((workspace) => workspace.workspacePath)
      .filter((path): path is string => typeof path === "string"),
  );
  if (workspacePaths.size === 0) return [];
  return readIndexedTasks().filter((task) => workspacePaths.has(String(task.workspacePath)));
}
