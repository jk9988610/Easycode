const fs = require("fs");

function must(file, label, cond) {
  if (!cond) {
    console.error("[" + file + "] anchor not found: " + label);
    process.exit(1);
  }
}

// 1) index.ts — 加 agent:rollback
{
  const p = "src/main/index.ts";
  let s = fs.readFileSync(p, "utf8");
  const anchor = 'ipcMain.handle("agent:list", () => agentHost?.list() ?? []);';
  must(p, "agent:list", s.includes(anchor));
  if (!s.includes('"agent:rollback"')) {
    s = s.replace(
      anchor,
      [
        '  ipcMain.handle("agent:rollback", async (_e, id: string) => {',
        '    if (!agentHost) return { ok: false, message: "no agent host" };',
        "    return await agentHost.rollback(id);",
        "  });",
        anchor,
      ].join("\n"),
    );
    fs.writeFileSync(p, s, "utf8");
    console.log("patched " + p);
  } else {
    console.log(p + " already has agent:rollback");
  }
}

// 2) preload.ts — 加 agentRollback
{
  const p = "src/preload/preload.ts";
  let s = fs.readFileSync(p, "utf8");
  const anchor = '  agentList: () => ipcRenderer.invoke("agent:list"),';
  must(p, "agentList", s.includes(anchor));
  if (!s.includes("agentRollback:")) {
    s = s.replace(
      anchor,
      [
        "  agentRollback: (id: string): Promise<{ ok: boolean; message: string }> =>",
        '    ipcRenderer.invoke("agent:rollback", id),',
        anchor,
      ].join("\n"),
    );
    fs.writeFileSync(p, s, "utf8");
    console.log("patched " + p);
  } else {
    console.log(p + " already has agentRollback");
  }
}

// 3) types.ts — 加类型
{
  const p = "src/renderer/types.ts";
  let s = fs.readFileSync(p, "utf8");
  const anchor =
    "  gitShow: (root: string, rev: string, path: string) => Promise<{ ok: boolean; content?: string; error?: string }>;";
  must(p, "gitShow", s.includes(anchor));
  if (!s.includes("agentRollback:")) {
    s = s.replace(
      anchor,
      [
        anchor,
        "  agentRollback: (id: string) => Promise<{ ok: boolean; message: string }>;",
      ].join("\n"),
    );
    fs.writeFileSync(p, s, "utf8");
    console.log("patched " + p);
  } else {
    console.log(p + " already has agentRollback");
  }
}

console.log("done");