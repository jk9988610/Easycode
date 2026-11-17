"""工具的 JSON Schema 定义:description 写得越清楚,模型越不容易调错。"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "读取指定文件。可只读指定行区间(大文件推荐),"
                "省略 start/end 则读全文。修改文件前必须先读取。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件的绝对或相对路径",
                    },
                    "start": {
                        "type": "integer",
                        "description": "起始行号(1-based,含)。可选",
                    },
                    "end": {
                        "type": "integer",
                        "description": "结束行号(1-based,含)。可选",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "创建新文件或整体覆写文件。创建文件必须用本工具,"
                "严禁用 echo / 输出重定向创建文件(会产生多余空格、错误换行符和编码问题)。"
                "已存在的文件会自动沿用原编码并生成 .bak 备份。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径",
                    },
                    "content": {
                        "type": "string",
                        "description": "写入的完整文件内容",
                    },
                    "encoding": {
                        "type": "string",
                        "enum": ["utf-8", "gbk"],
                        "description": "仅对新建文件生效,默认 utf-8。中文 Windows 下的 C/嵌入式工程若需 GBK 可指定 gbk",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "将文件中指定的旧文本替换为新文本,用于修改已有代码。"
                "内部走多级匹配(精确 → 空白归一化 → 首尾锚点块匹配),"
                "缩进/行尾空格轻微不一致也能命中。"
                "若返回'未找到',会附带文件当前相关片段,直接从中复制 old_text 重试即可,无需再 read_file。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径",
                    },
                    "old_text": {
                        "type": "string",
                        "description": "要被替换的原文本,必须与 read_file 返回的内容逐字符一致",
                    },
                    "new_text": {
                        "type": "string",
                        "description": "替换后的新文本",
                    },
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "列出目录内容(单层)。查看目录结构优先用本工具,不要用 ls/dir 等 shell 命令。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "目录路径,默认为工作区根目录",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "在工作目录下执行 shell 命令,用于运行测试、格式化、Git 操作等。查看目录/读写文件请用专用工具,不要用本工具。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "要执行的命令,如 pytest tests/",
                    }
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_script",
            "description": (
                "执行一段多行脚本。写入临时文件后执行,天然支持多行,不用管 shell 转义。"
                "适合: 统计/批处理/多语句逻辑/复杂引号。"
                "单行命令(如 dir、npm run build、git status)仍用 run_command。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "enum": ["python", "node", "powershell", "cmd"],
                        "description": "脚本语言",
                    },
                    "code": {
                        "type": "string",
                        "description": "完整脚本内容(可多行)",
                    },
                },
                "required": ["language", "code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "attempt_completion",
            "description": (
                "当你确认任务已经完成时调用,附上最终总结。"
                "调用后本轮立即结束,不再继续调用工具。"
                "适用于:任务目标已达成、改动已验证。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "result": {
                        "type": "string",
                        "description": "给用户的最终总结:完成了什么、关键改动、验证结果",
                    },
                },
                "required": ["result"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_followup_question",
            "description": (
                "当你需要用户做决策时调用(方案选择、删/留判断、外部信息)。"
                "调用后本轮暂停,等待用户回答,回答作为工具结果返回。"
                "有明确选项用 options 数组,开放式问题省略。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "向用户提出的问题",
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选的候选答案列表(推荐填写),用户可点击选择",
                    },
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_symbols",
            "description": (
                "列出 Python 文件的顶层函数/类和类内方法，含行号范围和签名。"
                "大文件快速定位符号，避免整文件读取。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Python 文件路径"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_symbol",
            "description": (
                "读取指定符号（函数/类/类方法）的完整源码，带行号。"
                "比 read_file 精确，不烧上下文。支持 Class.method 点号。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Python 文件路径"},
                    "name": {"type": "string", "description": "符号名，如 foo 或 Class.method"},
                },
                "required": ["path", "name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "patch_symbol",
            "description": (
                "按符号名替换整个函数/类定义。new_body 缩进自动对齐到原符号。"
                "写入前做语法校验，失败不写。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Python 文件路径"},
                    "name": {"type": "string", "description": "符号名，如 foo 或 Class.method"},
                    "new_body": {
                        "type": "string",
                        "description": "新的完整定义（含 def/class 行），缩进可写 0 层，自动对齐",
                    },
                    "dry_run": {"type": "boolean", "description": "true 时只返回 diff，不写文件"},
                },
                "required": ["path", "name", "new_body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "who_uses",
            "description": (
                "查 symbol 在项目中被谁引用（AST 精确名匹配，不做类型推断/LSP）。"
                "返回 JSON: {symbol, files_scanned, hits:[{file,line,kind,scope}], errors, truncated}。"
                "kind ∈ call/attr/name/import/def。改代码前用这个评估影响面。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "要查的符号名，如 foo 或 method"},
                    "path": {"type": "string", "description": "搜索目录，相对工作区，默认 '.'"},
                    "ext": {"type": "string", "description": "文件后缀，默认 '.py'"},
                    "include_def": {"type": "boolean", "description": "是否含 def/class 定义点，默认 false"},
                    "max_files": {"type": "integer", "description": "最多扫描文件数，默认 500"},
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_code",



            "description": (
                "按正则或字面量搜索文件内容,返回 文件:行号:内容。"
                "用于定位符号定义/引用、找 TODO/FIXME、全局替换前摸底。"
                "不要用 shell 的 grep/findstr(跨平台不一致且易受编码干扰)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "正则或字面量。正则非法时自动按字面量搜索",
                    },
                    "path": {
                        "type": "string",
                        "description": "搜索根目录,默认工作区根。可选",
                    },
                    "include": {
                        "type": "string",
                        "description": "逗号分隔的文件名 glob 白名单,如 '*.py,*.ts'。可选",
                    },
                    "exclude": {
                        "type": "string",
                        "description": "逗号分隔的文件名 glob 黑名单,如 '*.min.js'。可选",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "返回条数上限,默认 50。可选",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_files",
            "description": (
                "按 glob 模式递归查找文件(如 *.py / **/*.ts / src/**/*.js),返回相对路径列表。"
                "用于确认某类文件是否存在、摸清目录布局。不要用 dir/ls 逐层翻。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "glob 模式,如 '*.py'、'**/*.ts'、'src/**/*.js'",
                    },
                    "path": {
                        "type": "string",
                        "description": "查找根目录,默认工作区根。可选",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "restart_self",
            "description": (
                "触发 Easycode 主进程自重启。"
                "前提：改动已通过 typecheck/build 验证。"
                "仅用于修改 Easycode 自身代码后让改动生效。"
                "调用后 Easycode 会在 1 秒内自动重启，当前对话会中断。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "重启原因(会记入日志)",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory",
            "description": (
                "项目经验库。任务开始前用 search 查相关经验(避免重复踩坑),"
                "任务完成后用 write 记一条可复用的教训。按 title 合并。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": ["search", "get", "write"],
                        "description": "search 查列表 / get 按 id 取完整 / write 写一条(按 title 合并)",
                    },
                    "id": {"type": "string", "description": "get 用: 记忆 id"},
                    "tag": {"type": "string", "description": "search 用: 按 tag 过滤(不区分大小写)"},
                    "text": {"type": "string", "description": "search 用: 全字段模糊搜"},
                    "type": {"type": "string", "description": "search/write 用: bug|trap|feat|note"},
                    "memory_status": {
                        "type": "string",
                        "enum": ["open", "resolved", "wontfix"],
                        "description": "search/write 用: 记忆状态(避免与工具 status 混淆,故命名 memory_status)",
                    },
                    "full": {"type": "boolean", "description": "search 用: true 时返回完整 sections"},
                    "title": {"type": "string", "description": "write 用: 必填,一句话,建议 [TRAP]/[BUG]/[FEAT] 前缀"},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "write 用: 3-8 个小写 tag"},
                    "sections": {"type": "object", "description": "write 用: {现象/根因/修复/文件/验证/教训}"},
                },
                "required": ["op"],
            },
        },
    },
]

# 只读工具子集:Plan 模式只给模型这些,禁止其修改文件/执行命令。
# memory 加入只读集:Plan 阶段查经验有用,write 只写经验库不改代码。
_READONLY_NAMES = {"read_file", "list_dir", "search_code", "find_files", "memory"}
TOOLS_READONLY = [t for t in TOOLS if t["function"]["name"] in _READONLY_NAMES]
