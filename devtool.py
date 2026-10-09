"""
EasyCode DevTool — 可视化 patch / 文件操作 / typecheck / commit （深色主题）
"""
import os
import sys
import json
import time
import shutil
import threading
import re
import subprocess


def _find_node_exe():
    import os as _os
    import shutil as _sh
    env = _os.environ.get("NODE_EXE")
    if env and _os.path.exists(env):
        return env
    p = _sh.which("node")
    if p:
        return p
    candidates = [
        "C:/Program Files/nodejs/node.exe",
        "C:/Program Files (x86)/nodejs/node.exe",
        _os.path.expandvars("%LOCALAPPDATA%/Programs/nodejs/node.exe"),
        _os.path.expandvars("%APPDATA%/nvm/node.exe"),
        _os.path.expandvars("%USERPROFILE%/.volta/bin/node.exe"),
    ]
    for c in candidates:
        if _os.path.exists(c):
            return c
    if _os.name == "nt":
        try:
            import winreg
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(hive, "SOFTWARE" + chr(92) + "Node.js") as k:
                        base, _ = winreg.QueryValueEx(k, "InstallPath")
                        exe = _os.path.join(base, "node.exe")
                        if _os.path.exists(exe):
                            return exe
                except OSError:
                    pass
        except ImportError:
            pass
    raise RuntimeError("Cannot find node.exe. Install Node.js or set NODE_EXE env var.")

def _resolve_exe(name):
    import os as _os
    if name == "node":
        try:
            return _find_node_exe()
        except RuntimeError:
            return name
    if name in ("npm", "npm.cmd", "npx", "npx.cmd"):
        try:
            np = _find_node_exe()
        except RuntimeError:
            return name
        base = _os.path.dirname(np)
        target = _os.path.join(base, name if name.endswith(".cmd") else name + ".cmd")
        if _os.path.exists(target):
            return target
        return name
    if name in ("python", "python3", "python.exe"):
        import sys as _sys
        return _sys.executable
    if name in ("tsc", "tsc.cmd"):
        local = _os.path.join(ROOT, "node_modules", ".bin", "tsc.cmd")
        if _os.path.exists(local):
            return local
        return name
    return name


def _patch_cmd(name):
    if name.endswith(".py"):
        import sys as _sys
        return [_sys.executable, name]
    if name.endswith(".cjs"):
        try:
            return [_find_node_exe(), name]
        except RuntimeError:
            return ["node", name]
    return ["node", name]

def _rewrite_shell_cmd(cmd):
    if not cmd:
        return cmd
    parts = cmd.split(None, 1)
    if not parts:
        return cmd
    first = parts[0]
    resolved = _resolve_exe(first)
    if resolved != first:
        if " " in resolved:
            resolved = chr(34) + resolved + chr(34)
        if len(parts) == 2:
            return resolved + " " + parts[1]
        return resolved
    return cmd


import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox

ROOT = os.path.dirname(os.path.abspath(__file__))

# ================= 配色 =================
BG        = "#0d1117"
BG_PANEL  = "#161b22"
BG_ENTRY  = "#0a0d12"
FG        = "#e6edf2"
FG_MUTED  = "#7d8590"
ACCENT    = "#58a6ff"
ACCENT_H  = "#79b8ff"
LINE      = "#30363d"
HOVER     = "#1f2429"
DANGER    = "#f85149"
OK        = "#3fb950"


def apply_dark_theme(root):
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    root.configure(bg=BG)

    style.configure("TNotebook", background=BG, borderwidth=0)
    style.configure("TNotebook.Tab",
                    background=BG_PANEL, foreground=FG_MUTED,
                    padding=(14, 7), borderwidth=0)
    style.map("TNotebook.Tab",
              background=[("selected", BG), ("active", HOVER)],
              foreground=[("selected", ACCENT), ("active", FG)])

    style.configure("TLabelframe", background=BG, foreground=FG_MUTED,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE)
    style.configure("TLabelframe.Label", background=BG, foreground=FG_MUTED)

    style.configure("TFrame", background=BG)
    style.configure("TLabel", background=BG, foreground=FG)

    style.configure("TButton",
                    background=BG_PANEL, foreground=FG,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE,
                    focuscolor=ACCENT, relief="flat", padding=(10, 5))
    style.map("TButton",
              background=[("active", HOVER), ("pressed", ACCENT)],
              foreground=[("active", FG)],
              bordercolor=[("active", ACCENT)])

    style.configure("TEntry",
                    fieldbackground=BG_ENTRY, foreground=FG,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE,
                    insertcolor=FG)
    style.map("TEntry", bordercolor=[("focus", ACCENT)])

    style.configure("TCombobox",
                    fieldbackground=BG_ENTRY, background=BG_PANEL,
                    foreground=FG, arrowcolor=FG_MUTED,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE)
    style.map("TCombobox",
              fieldbackground=[("readonly", BG_ENTRY)],
              foreground=[("readonly", FG)],
              bordercolor=[("focus", ACCENT)],
              arrowcolor=[("active", ACCENT)])
    root.option_add("*TCombobox*Listbox.background", BG_ENTRY)
    root.option_add("*TCombobox*Listbox.foreground", FG)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
    root.option_add("*TCombobox*Listbox.selectForeground", BG)
    root.option_add("*TCombobox*Listbox.borderWidth", "0")


class App:
    def __init__(self, root):
        self.root = root
        root.title("EasyCode DevTool")
        root.geometry("1060x820")
        root.minsize(880, 640)

        apply_dark_theme(root)

        top = ttk.Frame(root)
        top.pack(fill="x", padx=12, pady=(10, 0))
        self.status_var = tk.StringVar(value="就绪")
        ttk.Label(top, textvariable=self.status_var, foreground=FG_MUTED).pack(side="left")

        self.nb = ttk.Notebook(root)
        self.nb.pack(fill="both", expand=True, padx=12, pady=(6, 4))

        self.tab_files = ttk.Frame(self.nb)
        self.tab_patch = ttk.Frame(self.nb)
        # 顺序：文件操作 在 左，Patch 在 右
        self.nb.add(self.tab_files, text="  文件操作  ")
        self.nb.add(self.tab_patch, text="  Patch & Commit  ")
        self.tab_help = ttk.Frame(self.nb)
        self.nb.add(self.tab_help, text="  帮助  ")

        self._build_files_tab()
        self._build_patch_tab()
        self._build_help_tab()

        out = ttk.LabelFrame(root, text="输出", padding=8)
        out.pack(fill="both", expand=True, padx=12, pady=(0, 12))

        self.output = scrolledtext.ScrolledText(
            out, wrap="word", font=("Consolas", 10),
            bg=BG_ENTRY, fg=FG, insertbackground=FG,
            selectbackground=ACCENT, selectforeground=BG,
            relief="flat", borderwidth=0,
        )
        self.output.pack(fill="both", expand=True)

        bar = ttk.Frame(out)
        bar.pack(fill="x", pady=(8, 0))
        ttk.Button(bar, text="📋 复制全部输出", command=self.copy_all).pack(side="right")
        ttk.Button(bar, text="🗑 清空", command=self.clear_log).pack(side="right", padx=6)

        self.log("欢迎使用 EasyCode DevTool（深色主题）\n")

    # ================= Patch Tab =================
    def _build_patch_tab(self):
        f1 = ttk.LabelFrame(self.tab_patch, text="① Patch 脚本", padding=10)
        f1.pack(fill="x", padx=12, pady=(12, 4))

        self.patch_var = tk.StringVar()
        self.patch_combo = ttk.Combobox(f1, textvariable=self.patch_var, width=42, state="readonly")
        self.patch_combo.pack(side="left", padx=(0, 6))
        ttk.Button(f1, text="🔄 刷新", command=self.refresh_patches, width=8).pack(side="left", padx=2)
        ttk.Button(f1, text="▶ 运行 Patch", command=self.run_patch, width=12).pack(side="left", padx=2)
        self.auto_tc_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(f1, text="patch 后自动 typecheck", variable=self.auto_tc_var).pack(side="left", padx=8)
        ttk.Button(f1, text="🔍 Typecheck", command=self.run_typecheck, width=12).pack(side="left", padx=2)

        f2 = ttk.LabelFrame(self.tab_patch, text="② 提交", padding=10)
        f2.pack(fill="x", padx=12, pady=4)
        ttk.Label(f2, text="Commit 信息:").pack(side="left")
        self.msg_var = tk.StringVar()
        ttk.Entry(f2, textvariable=self.msg_var).pack(side="left", padx=6, fill="x", expand=True)
        ttk.Button(f2, text="📝 提交", command=self.run_commit, width=10).pack(side="left", padx=2)
        ttk.Button(f2, text="📊 状态", command=self.run_status, width=10).pack(side="left", padx=2)

        f3 = ttk.LabelFrame(self.tab_patch, text="③ 一键流程", padding=10)
        f3.pack(fill="x", padx=12, pady=4)
        ttk.Button(f3, text="▶ Patch + Typecheck",
                   command=self.run_all_patch_check, width=26).pack(side="left", padx=4)
        ttk.Button(f3, text="🚀 智能运行",
                   command=lambda: self.smart_run("patch"), width=18).pack(side="left", padx=6)
        ttk.Button(f3, text="▶ Patch + Typecheck + 提交",
                   command=self.run_full, width=30).pack(side="left", padx=4)

        self.refresh_patches()

    # ================= 帮助 Tab =================
    def _build_help_tab(self):
        f = ttk.Frame(self.tab_help)
        f.pack(fill="both", expand=True, padx=12, pady=12)
        txt = scrolledtext.ScrolledText(
            f, wrap="word", font=("Consolas", 10),
            bg=BG_ENTRY, fg=FG, insertbackground=FG,
            selectbackground=ACCENT, selectforeground=BG,
            relief="flat", borderwidth=0,
        )
        txt.pack(fill="both", expand=True)
        help_path = os.path.join(ROOT, "help.txt")
        if os.path.exists(help_path):
            with open(help_path, "r", encoding="utf-8") as fh:
                txt.insert("1.0", fh.read())
        else:
            txt.insert("1.0", "（未找到 help.txt，请创建后再打开本页）")
        txt.configure(state="disabled")

    # ================= 文件操作 Tab =================
    def _build_files_tab(self):
        info = ttk.Label(
            self.tab_files,
            text="粘贴 JSON 数组（点『示例』看格式）。支持的操作：\n"
                 "  write   覆盖写入      {op:'write',  path:'...', content:'...'}\n"
                 "  append  追加到末尾    {op:'append', path:'...', content:'...'}\n"
                 "  delete  删除文件/目录  {op:'delete', path:'...'}\n"
                 "  mkdir   创建目录      {op:'mkdir',  path:'...'}",
            justify="left", foreground=FG_MUTED,
        )
        info.pack(fill="x", padx=12, pady=(12, 4))

        bar = ttk.Frame(self.tab_files)
        bar.pack(fill="x", padx=12)
        ttk.Button(bar, text="📂 从 devtasks.json 加载", command=self.load_devtasks).pack(side="left")
        ttk.Button(bar, text="📋 示例", command=self.load_example).pack(side="left", padx=6)
        ttk.Button(bar, text="🗑 清空", command=lambda: self.ops_text.delete("1.0", "end")).pack(side="left")
        ttk.Button(bar, text="📋 粘贴剪贴板", command=self.paste_from_clipboard, width=16).pack(side="left", padx=6)

        self.ops_text = scrolledtext.ScrolledText(
            self.tab_files, height=16, wrap="word", font=("Consolas", 10),
            bg=BG_ENTRY, fg=FG, insertbackground=FG,
            selectbackground=ACCENT, selectforeground=BG,
            relief="flat", borderwidth=0,
        )
        self.ops_text.pack(fill="both", expand=True, padx=12, pady=6)

        bottom = ttk.Frame(self.tab_files)
        bottom.pack(fill="x", padx=12, pady=(0, 12))
        ttk.Button(bottom, text="▶ 执行文件操作",
                   command=self.run_file_ops, width=20).pack(side="left", padx=2)
        ttk.Button(bottom, text="⚡ 一键运行",
                   command=self.run_oneclick, width=18).pack(side="left", padx=6)
        ttk.Button(bottom, text="🚀 智能运行",
                   command=lambda: self.smart_run("files"), width=18).pack(side="left", padx=6)
        ttk.Button(bottom, text="▶ 执行 + Patch + Typecheck",
                   command=self.run_ops_patch_check, width=30).pack(side="left", padx=6)

    # ================= 通用 =================
    def log(self, text):
        def _do():
            out = text
            # filter CRLF warnings
            if "warning: LF will be replaced" in out or "warning: in the working copy" in out:
                _lines = out.split(chr(10))
                _lines = [l for l in _lines if "warning: LF will be replaced" not in l and "warning: in the working copy" not in l]
                out = chr(10).join(_lines)
                if not out.strip():
                    return
            self.output.insert("end", out)
            if not out.endswith("\n"):
                self.output.insert("end", "\n")
            self.output.see("end")
        self.root.after(0, _do)

    def clear_log(self):
        self.output.delete("1.0", "end")

    def paste_from_clipboard(self):
        try:
            content = self.root.clipboard_get()
        except Exception:
            self.set_status("剪贴板为空或不可读")
            return
        if not isinstance(content, str):
            content = str(content)
        self.ops_text.delete("1.0", "end")
        self.ops_text.insert("1.0", content)
        self.set_status("已粘贴剪贴板内容（" + str(len(content)) + " 字符）")

    def _get_clipboard(self):
        try:
            content = self.root.clipboard_get()
        except Exception:
            return None
        if not isinstance(content, str):
            content = str(content)
        return content

    def _extract_json_blocks(self, text):
        parts = text.split("```")
        results = []
        i = 1
        while i < len(parts):
            block = parts[i]
            if block.startswith("json"):
                block = block[4:]
            block = block.strip()
            try:
                data = json.loads(block)
                if isinstance(data, list):
                    results.append(data)
            except Exception:
                pass
            i += 2
        return results

    def _try_parse_ops_json(self, text):
        s = text.strip()
        if not s.startswith("["):
            return None
        try:
            data = json.loads(s)
            if isinstance(data, list):
                return data
        except Exception:
            pass
        return None

    def _find_patch_name(self, text):
        idx = text.find("patch-")
        if idx < 0:
            return None
        end_py = text.find(".py", idx)
        end_cjs = text.find(".cjs", idx)
        if end_py < 0 and end_cjs < 0:
            return None
        if end_py < 0:
            end, ext_len = end_cjs, 4
        elif end_cjs < 0:
            end, ext_len = end_py, 3
        elif end_py < end_cjs:
            end, ext_len = end_py, 3
        else:
            end, ext_len = end_cjs, 4
        candidate = text[idx:end + ext_len]
        for ch in candidate:
            if ch in " " + chr(9) + chr(13) + chr(10):
                return None
        return candidate

    def _try_parse_shell_lines(self, text):
        s = text.strip()
        if not s or len(s) > 4000:
            return None
        if chr(96) * 3 in s:
            return None
        lines = [l.strip() for l in s.split(chr(10))]
        lines = [l for l in lines if l]
        if not lines or len(lines) > 20:
            return None
        known = {'npm', 'npx', 'node', 'python', 'python3', 'py', 'git', 'dir', 'type', 'findstr', 'echo', 'del', 'copy', 'move', 'mkdir', 'rmdir', 'cd', 'chdir', 'powershell', 'cmd', 'where', 'taskkill', 'cls', 'attrib', 'ren', 'rename', 'start', 'call', 'set'}
        bad_start = ('{', '[', '#', '//', '>', '*', '|', '=', '<', '!')
        ops = []
        for l in lines:
            if l.startswith(bad_start):
                return None
            parts = l.split()
            if not parts:
                return None
            first = parts[0].lower()
            if first not in known:
                return None
            ops.append({'op': 'shell', 'cmd': l})
        return ops


    def smart_run(self, source_tab):
        content = self._get_clipboard()
        if not content:
            self.set_status("剪贴板为空或不可读")
            return
        ops = self._try_parse_ops_json(content)
        if ops is None:
            blocks = self._extract_json_blocks(content)
            if blocks:
                ops = blocks[0]
        patch_name = self._find_patch_name(content)
        if ops is not None:
            n = len(ops)
            self.set_status("识别为文件操作 JSON（" + str(n) + " 项），执行中...")
            self.ops_text.delete("1.0", "end")
            self.ops_text.insert("1.0", json.dumps(ops, ensure_ascii=False, indent=2))
            if source_tab != "files":
                self.nb.select(self.tab_files)
            self._auto_copy_after_run = True
            self.root.after(80, self.run_file_ops)
            return
        if patch_name:  # smart_run_patch_fixed
            self.set_status("识别 patch 脚本：" + patch_name + "，执行中...")
            self.refresh_patches()
            _vals = list(self.patch_combo["values"] or ())
            if patch_name not in _vals:
                self.clear_log()
                self.log("[智能运行] 未找到 patch 脚本：" + patch_name)
                self.log("")
                self.log("当前可用的 patch 脚本：")
                for _v in _vals:
                    self.log("  " + _v)
                self.log("")
                self.log("请确认文件名是否正确，或是否已写入项目根目录。")
                self.set_status("patch 脚本不存在：" + patch_name)
                return
            self.patch_var.set(patch_name)
            if source_tab != "patch":
                self.nb.select(self.tab_patch)
            self._auto_copy_after_run = True
            self.root.after(150, self.run_patch)
            return
        shell_ops = self._try_parse_shell_lines(content)
        if shell_ops:
            n = len(shell_ops)
            self.set_status("识别为 shell 命令（" + str(n) + " 条），执行中...")
            self.ops_text.delete("1.0", "end")
            self.ops_text.insert("1.0", json.dumps(shell_ops, ensure_ascii=False, indent=2))
            if source_tab != "files":
                self.nb.select(self.tab_files)
            self._auto_copy_after_run = True
            self.root.after(80, self.run_file_ops)
            return
        self.ops_text.delete("1.0", "end")
        self.ops_text.insert("1.0", content)
        if source_tab == "patch":
            self.nb.select(self.tab_files)
        self.clear_log()
        self.log("[智能运行] 未识别出明确指令，内容已填入输入框。")
        self.log("")
        self.log("支持以下三种输入格式：")
        self.log("  1. JSON 数组（含 ```json 代码块）")
        self.log("  2. patch-xxx.py 或 patch-xxx.cjs 文件名")
        self.log("  3. 多行 shell 命令（每行以已知命令词开头，如 git/npm/node）")
        self.log("")
        self.log("如要执行当前内容，请手动编辑为上述格式后点「▶ 执行文件操作」。")
        self.set_status("未识别出明确指令，已填入输入框")

    def copy_all(self):
        text = self.output.get("1.0", "end").rstrip()
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        messagebox.showinfo("复制", "输出已复制到剪贴板")

    def _copy_silent(self):
        text = self.output.get("1.0", "end").rstrip()
        self.root.clipboard_clear()
        self.root.clipboard_append(text)

    def set_status(self, t):
        self.root.after(0, lambda: self.status_var.set(t))

    def run_cmd(self, cmd, cwd=ROOT):
        if cmd:
            cmd = list(cmd)
            cmd[0] = _resolve_exe(cmd[0])
        self.log("$ " + " ".join(cmd))
        try:
            p = subprocess.run(
                cmd, cwd=cwd, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            if p.stdout:
                self.log(p.stdout.rstrip())
            if p.stderr:
                self.log(p.stderr.rstrip())
            self.log(f"[exit {p.returncode}]\n")
            return p.returncode
        except Exception as e:
            self.log(f"[错误] {e}\n")
            return -1

    # ================= Patch 相关 =================
    def refresh_patches(self):
        try:
            files = sorted(
                (f for f in os.listdir(ROOT)
                 if f.startswith("patch-") and (f.endswith(".py") or f.endswith(".cjs"))),
                key=lambda f: (0 if f.endswith(".py") else 1, f),
            )
        except OSError:
            files = []
        self.patch_combo["values"] = files
        if files and not self.patch_var.get():
            self.patch_var.set(files[0])

    def run_patch(self):
        name = self.patch_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "选择 patch 脚本")
        threading.Thread(target=self._bg_patch, args=(name,), daemon=True).start()

    def _bg_patch(self, name):
        self.clear_log()
        self.set_status("运行 patch...")
        c = self.run_cmd(_patch_cmd(name))
        self.log("✅ Patch 成功\n" if c == 0 else "❌ Patch 失败\n")
        self.set_status("patch 完成" if c == 0 else "patch 失败")
        if getattr(self, "_auto_copy_after_run", False):
            self._auto_copy_after_run = False
            self.root.after(80, self._copy_silent)
            self.set_status("patch 完成，输出已复制到剪贴板")
        if getattr(self, "auto_tc_var", None) is not None and self.auto_tc_var.get():
            self.root.after(200, self.run_typecheck)

    def run_typecheck(self):
        threading.Thread(target=self._bg_typecheck, daemon=True).start()

    def _bg_typecheck(self):
        self.clear_log()
        self.set_status("typecheck...")
        c = self.run_cmd(["npm", "run", "typecheck"])
        self.log("✅ Typecheck 通过\n" if c == 0 else "❌ Typecheck 失败\n")
        self.set_status("typecheck 通过" if c == 0 else "typecheck 失败")

    def run_status(self):
        threading.Thread(
            target=lambda: self.run_cmd(["git", "status", "--short"]),
            daemon=True,
        ).start()

    def run_commit(self):
        msg = self.msg_var.get().strip()
        if not msg:
            return messagebox.showwarning("提示", "输入 commit 信息")
        threading.Thread(target=self._bg_commit, args=(msg,), daemon=True).start()

    def _bg_commit(self, msg):
        self.clear_log()
        self.set_status("提交中...")
        if self.run_cmd(["git", "add", "-A"]) != 0:
            self.set_status("git add 失败")
            return
        if self.run_cmd(["git", "commit", "-m", msg]) != 0:
            self.log("⚠️ 提交失败\n")
            self.set_status("提交失败")
            return
        self.log("✅ 已提交\n")
        self.run_cmd(["git", "log", "--oneline", "-3"])
        self.set_status("提交成功")

    def run_all_patch_check(self):
        name = self.patch_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "选择 patch 脚本")
        threading.Thread(target=self._bg_patch_check, args=(name,), daemon=True).start()

    def _bg_patch_check(self, name):
        self.clear_log()
        self.set_status("Patch 中...")
        if self.run_cmd(_patch_cmd(name)) != 0:
            self.log("❌ Patch 失败\n")
            self.set_status("Patch 失败")
            return
        self.log("✅ Patch 成功\n\n")
        self.set_status("Typecheck 中...")
        if self.run_cmd(["npm", "run", "typecheck"]) != 0:
            self.log("❌ Typecheck 失败\n")
            self.set_status("Typecheck 失败")
            return
        self.log("✅ Typecheck 通过\n\n")
        self.run_cmd(["git", "status", "--short"])
        self.set_status("Patch + Typecheck 通过")

    def run_full(self):
        name = self.patch_var.get().strip()
        msg = self.msg_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "选择 patch")
        if not msg:
            return messagebox.showwarning("提示", "输入 commit 信息")
        threading.Thread(target=self._bg_full, args=(name, msg), daemon=True).start()

    def _bg_full(self, name, msg):
        self.clear_log()
        self.set_status("① Patch...")
        if self.run_cmd(_patch_cmd(name)) != 0:
            self.log("❌ Patch 失败\n")
            return
        self.log("✅ Patch 成功\n\n")
        self.set_status("② Typecheck...")
        if self.run_cmd(["npm", "run", "typecheck"]) != 0:
            self.log("❌ Typecheck 失败\n")
            return
        self.log("✅ Typecheck 通过\n\n")
        self.set_status("③ git add...")
        if self.run_cmd(["git", "add", "-A"]) != 0:
            self.log("❌ git add 失败\n")
            return
        self.set_status("④ git commit...")
        if self.run_cmd(["git", "commit", "-m", msg]) != 0:
            self.log("❌ 提交失败\n")
            return
        self.log("✅ 已提交\n")
        self.run_cmd(["git", "log", "--oneline", "-3"])
        self.set_status("🎉 全部完成")

    # ================= 文件操作相关 =================
    def load_example(self):
        example = json.dumps([
            {"op": "write", "path": "src/example.ts", "content": "export const X = 1;\n"},
            {"op": "append", "path": "src/example.ts", "content": "export const Y = 2;\n"},
            {"op": "delete", "path": "patch-temp.cjs"},
            {"op": "mkdir", "path": "src/newdir"},
        ], indent=2, ensure_ascii=False)
        self.ops_text.delete("1.0", "end")
        self.ops_text.insert("1.0", example)

    def load_devtasks(self):
        p = os.path.join(ROOT, "devtasks.json")
        if not os.path.exists(p):
            return messagebox.showwarning("提示", "找不到 devtasks.json")
        try:
            with open(p, "r", encoding="utf-8") as f:
                self.ops_text.delete("1.0", "end")
                self.ops_text.insert("1.0", f.read())
            self.log("已加载 devtasks.json\n")
        except Exception as e:
            messagebox.showerror("错误", str(e))

    def run_file_ops(self):
        threading.Thread(target=self._bg_file_ops, daemon=True).start()

    def _bg_file_ops(self):
        self.clear_log()  # bg_file_ops_clear_log_fixed
        raw = self.ops_text.get("1.0", "end").strip()
        if not raw:
            return self.root.after(0, lambda: messagebox.showwarning("提示", "JSON 为空"))
        try:
            tasks = json.loads(raw)
        except Exception as e:
            self.log(f"[JSON 解析失败] {e}\n")
            return
        if not isinstance(tasks, list):
            self.log("[错误] 顶层应为数组\n")
            return
        self.set_status("执行文件操作...")
        ok, fail = self._exec_tasks(tasks)
        self.log(f"\n完成: {ok} 成功, {fail} 失败\n")
        self.set_status(f"{ok} 成功 / {fail} 失败")
        if getattr(self, "_auto_copy_after_run", False):
            self._auto_copy_after_run = False
            self.root.after(80, self._copy_silent)
            self.set_status("文件操作完成，输出已复制到剪贴板")

    def _exec_tasks(self, tasks):
        ok, fail = 0, 0
        for i, t in enumerate(tasks, 1):
            try:
                op = t.get("op")
                path = t.get("path", "")
                full = os.path.join(ROOT, path)
                if op == "write":
                    d = os.path.dirname(full)
                    if d:
                        os.makedirs(d, exist_ok=True)
                    with open(full, "w", encoding="utf-8", newline="") as f:
                        f.write(t.get("content", ""))
                    self.log(f"[{i}] write  ✓ {path}")
                elif op == "append":
                    d = os.path.dirname(full)
                    if d:
                        os.makedirs(d, exist_ok=True)
                    with open(full, "a", encoding="utf-8", newline="") as f:
                        f.write(t.get("content", ""))
                    self.log(f"[{i}] append ✓ {path}")
                elif op == "delete":
                    if os.path.exists(full):
                        if os.path.isdir(full):
                            shutil.rmtree(full)
                        else:
                            os.remove(full)
                        self.log(f"[{i}] delete ✓ {path}")
                    else:
                        self.log(f"[{i}] delete ⚠ 不存在: {path}")
                elif op == "mkdir":
                    os.makedirs(full, exist_ok=True)
                    self.log(f"[{i}] mkdir  ✓ {path}")
                elif op == "shell":
                    cmd = t.get("cmd", "")
                    if not cmd:
                        raise ValueError("empty cmd")
                    cmd = _rewrite_shell_cmd(cmd)
                    self.log(f"[{i}] shell  $ {cmd}")
                    sp = subprocess.run(
                        cmd, cwd=ROOT, shell=True, capture_output=True,
                        text=True, encoding="utf-8", errors="replace",
                    )
                    if sp.stdout:
                        self.log(sp.stdout.rstrip())
                    if sp.stderr:
                        self.log(sp.stderr.rstrip())
                    self.log(f"[exit {sp.returncode}]")
                    if sp.returncode != 0:
                        fail += 1
                        continue
                else:
                    self.log(f"[{i}] ⚠ 未知 op: {op}")
                    fail += 1
                    continue
                ok += 1
            except Exception as e:
                self.log(f"[{i}] ❌ {path}: {e}")
                fail += 1
        return ok, fail

    # ================= 一键运行 =================
    def run_oneclick(self):
        threading.Thread(target=self._bg_oneclick, daemon=True).start()

    def _bg_oneclick(self):
        raw = self.ops_text.get("1.0", "end").strip()
        if not raw:
            return self.root.after(0, lambda: messagebox.showwarning("提示", "JSON 为空"))
        try:
            tasks = json.loads(raw)
        except Exception as e:
            self.log(f"[JSON 解析失败] {e}\n")
            return
        if not isinstance(tasks, list):
            self.log("[错误] 顶层应为数组\n")
            return

        self.clear_log()

        # ① 文件操作
        self.set_status("① 文件操作...")
        ok, fail = self._exec_tasks(tasks)
        self.log(f"\n文件操作: {ok} 成功 / {fail} 失败\n\n")

        # 找最后一个 write 的文件名
        last_written = None
        for t in tasks:
            if t.get("op") == "write" and t.get("path"):
                last_written = t.get("path")

        if not last_written:
            self.log("⚠ 没有 write 操作，跳过 Patch\n")
            self.root.after(0, self._copy_silent)
            self.set_status("文件操作完成（无 Patch），输出已复制")
            return

        name = os.path.basename(last_written)

        # ② 切到 Patch tab、刷新、选中
        self.set_status("② 切换到 Patch tab...")
        def _switch():
            self.nb.select(self.tab_patch)
            self.refresh_patches()
            values = self.patch_combo["values"] or ()
            if name in values:
                self.patch_var.set(name)
        self.root.after(0, _switch)
        time.sleep(0.15)

        # ③ 运行 Patch
        self.set_status(f"③ 运行 {name} ...")
        if self.run_cmd(_patch_cmd(name)) != 0:
            self.log("❌ Patch 失败\n")
            self.root.after(0, self._copy_silent)
            self.set_status("Patch 失败，输出已复制")
            return
        self.log("✅ Patch 成功\n")

        # ④ 复制输出
        self.root.after(0, self._copy_silent)
        self.set_status("🎉 一键运行完成，输出已复制到剪贴板")

    def run_ops_patch_check(self):
        name = self.patch_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "先选 Patch 脚本")
        threading.Thread(target=self._bg_ops_patch_check, args=(name,), daemon=True).start()

    def _bg_ops_patch_check(self, name):
        self.clear_log()
        raw = self.ops_text.get("1.0", "end").strip()
        if raw:
            try:
                tasks = json.loads(raw)
                if isinstance(tasks, list):
                    self.set_status("① 文件操作...")
                    ok, fail = self._exec_tasks(tasks)
                    self.log(f"\n文件操作: {ok} 成功 / {fail} 失败\n\n")
            except Exception as e:
                self.log(f"[JSON 解析失败] {e}\n")
        self.set_status("② Patch...")
        if self.run_cmd(_patch_cmd(name)) != 0:
            self.log("❌ Patch 失败\n")
            return
        self.log("✅ Patch 成功\n\n")
        self.set_status("③ Typecheck...")
        if self.run_cmd(["npm", "run", "typecheck"]) != 0:
            self.log("❌ Typecheck 失败\n")
            return
        self.log("✅ Typecheck 通过\n\n")
        self.run_cmd(["git", "status", "--short"])
        self.set_status("文件操作 + Patch + Typecheck 通过")


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()