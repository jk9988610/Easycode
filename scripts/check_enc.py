from pathlib import Path

p = Path(r"E:\tools\Easycode\src\renderer\main.ts")
text = p.read_text(encoding="utf-8", errors="replace")
# broken quote on binary line — file is corrupt, just report length
print("len", len(text))
print(repr(text[18:120]))
