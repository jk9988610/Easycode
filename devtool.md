任何创建/覆盖/追加/删除/建目录的指令，都会写成这样的 JSON：

json
[
  {"op": "write", "path": "patch-xxx.cjs", "content": "...(完整脚本内容)..."},
  {"op": "delete", "path": "patch-old.cjs"}
]
流程：

切到「文件操作」tab

粘贴我给的 JSON

点 "▶ 执行 + Patch + Typecheck"（如果这次是创建 patch 脚本+运行）

全 ✅ 后切回「Patch & Commit」tab，填 commit 信息，提交

支持的操作：

op	作用	必需字段
write	覆盖写入（自动建目录）	path, content
append	追加到文件末尾	path, content
delete	删除文件或目录	path
mkdir	创建目录	path
路径：相对项目根目录（E:\tools\Easycode），比如 src/main/foo.ts、patch-xxx.cjs。
