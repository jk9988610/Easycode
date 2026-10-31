# -*- coding: utf-8 -*-
"""七牛 qiniu/conatus-free 的 tool_calls 实测。用法: python test_qiniu_fc.py"""
import os, sys, json

def mask(v):
    if not v: return '(空)'
    return v[:6] + '...' + v[-4:] if len(v) > 12 else '(已设置,长度 %d)' % len(v)

print('=== 环境自检 ===')
print('python:', sys.version.split()[0], sys.executable)
key = os.environ.get('QINIU_API_KEY') or os.environ.get('DEEPSEEK_API_KEY')
print('QINIU_API_KEY:', mask(os.environ.get('QINIU_API_KEY')))
print('DEEPSEEK_API_KEY:', mask(os.environ.get('DEEPSEEK_API_KEY')))
print('base_url:', os.environ.get('QINIU_BASE_URL', 'https://api.qnaigc.com/v1'))
print('model:', os.environ.get('QINIU_MODEL', 'qiniu/conatus-free'))

if not key:
    print('\n[FAIL] 当前进程看不到密钥。PowerShell 的 $env: 只在同一窗口/子进程有效,')
    print('       请在同一个 PowerShell 窗口里先 set 再 python 本脚本。')
    sys.exit(1)

try:
    from openai import OpenAI
except Exception as e:
    print('\n[FAIL] 无法 import openai:', e)
    sys.exit(1)

client = OpenAI(api_key=key, base_url=os.environ.get('QINIU_BASE_URL', 'https://api.qnaigc.com/v1'))
model = os.environ.get('QINIU_MODEL', 'qiniu/conatus-free')

tools = [{
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "读取指定文件的完整内容",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "文件路径"}},
            "required": ["path"],
        },
    },
}]

print('\n=== 请求 1: 期望触发工具调用 ===')
try:
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "你必须调用 read_file 工具读取 README.md,不要直接回答"}],
        tools=tools, tool_choice="auto", temperature=0,
    )
except Exception as e:
    print('[FAIL] 请求异常:', type(e).__name__, e)
    sys.exit(1)

msg = resp.choices[0].message
print('content   :', (msg.content or '')[:200])
print('tool_calls:', msg.tool_calls)
if msg.tool_calls:
    for tc in msg.tool_calls:
        print('  [OK] id=', tc.id)
        print('       name=', tc.function.name)
        print('       arguments=', tc.function.arguments)
        try:
            json.loads(tc.function.arguments)
            print('       arguments 是合法 JSON [OK]')
        except Exception as e:
            print('       [WARN] arguments 非法 JSON:', e)
    print('\n>>> 结论: 支持 Function Calling')
else:
    print('\n>>> 结论: 本次未返回 tool_calls。下面用 required 再验一次')

print('\n=== 请求 2: 强制 tool_choice=required 验证 ===')
try:
    resp2 = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "读取 README.md"}],
        tools=tools, tool_choice="required", temperature=0,
    )
    m2 = resp2.choices[0].message
    print('tool_calls:', m2.tool_calls)
    if m2.tool_calls:
        print('>>> 强制模式可返回 tool_calls,说明模型具备 FC 能力')
    else:
        print('>>> [FAIL] 强制 required 仍无 tool_calls —— 该模型未实现 FC')
except Exception as e:
    print('[WARN] required 不被支持或请求失败:', type(e).__name__, e)
    print('    (部分服务只支持 auto,这本身不等于 FC 不可用)')
