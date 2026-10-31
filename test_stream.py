# -*- coding: utf-8 -*-
import os, sys
from openai import OpenAI

client = OpenAI(
    api_key=os.environ['QINIU_API_KEY'],
    base_url='https://api.qnaigc.com/v1',
)

print('=== 测试 stream=True ===')
try:
    stream = client.chat.completions.create(
        model='qiniu/conatus-free',
        messages=[{'role': 'user', 'content': '数到 5,每个数字之间用空格'}],
        stream=True,
    )
    chunks = []
    for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            chunks.append(delta.content)
            print(f'  chunk: {delta.content!r}')
    print(f'\n完整: {"".join(chunks)!r}')
    print('结论: stream=True 可用')
except Exception as e:
    print(f'[FAIL] {type(e).__name__}: {e}')

print('\n=== 测试 stream=True + tools ===')
tools = [{
    'type': 'function',
    'function': {
        'name': 'read_file',
        'description': '读取文件',
        'parameters': {
            'type': 'object',
            'properties': {'path': {'type': 'string'}},
            'required': ['path'],
        },
    },
}]
try:
    stream = client.chat.completions.create(
        model='qiniu/conatus-free',
        messages=[{'role': 'user', 'content': '读一下 README.md'}],
        tools=tools, stream=True,
    )
    text_chunks = []
    tool_calls_acc = {}  # index -> {id, name, arguments}
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta.content:
            text_chunks.append(delta.content)
        if delta.tool_calls:
            for tc in delta.tool_calls:
                idx = tc.index
                if idx not in tool_calls_acc:
                    tool_calls_acc[idx] = {'id': '', 'name': '', 'arguments': ''}
                if tc.id:
                    tool_calls_acc[idx]['id'] = tc.id
                if tc.function:
                    if tc.function.name:
                        tool_calls_acc[idx]['name'] += tc.function.name
                    if tc.function.arguments:
                        tool_calls_acc[idx]['arguments'] += tc.function.arguments
    print(f'  文本 chunks: {len(text_chunks)} 个, 内容={"" .join(text_chunks)!r}')
    print(f'  工具调用: {tool_calls_acc}')
    if tool_calls_acc:
        print('结论: stream + tools 可用,tool_calls 需要按 index 聚合分片')
    else:
        print('结论: stream + tools 没返回 tool_calls(可能模型没触发)')
except Exception as e:
    print(f'[FAIL] {type(e).__name__}: {e}')
