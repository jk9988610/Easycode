const fs = require("fs");
const p = "src/renderer/main.ts";
const lines = fs.readFileSync(p, "utf8").split("\n");

if (lines.some((l) => l.includes("data-chat-rollback-bar"))) {
  console.log("already present, nothing to do");
  process.exit(0);
}

const idx = lines.findIndex((l) => l.includes(">清空</button>"));
if (idx === -1) {
  console.error("anchor '>清空</button>' not found");
  process.exit(1);
}

lines.splice(
  idx + 1,
  0,
  '            <button type="button" data-chat-rollback-bar title="回滚本轮改动">回滚</button>',
);

fs.writeFileSync(p, lines.join("\n"), "utf8");
console.log("inserted at line " + (idx + 2));