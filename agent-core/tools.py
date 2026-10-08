"""工具的 JSON Schema 定义:description 写得越清楚,模型越不容易调错。"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取指定文件的全部内容。修改文件前必须先读取。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件的绝对或相对路径",
                    }
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
            "description": "将文件中指定的旧文本精确替换为新文本。用于修改已有代码。",
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
]
