# EasyCode Git 使用手册

> 记录仓库配置、推送流程、常见问题。项目根：`D:\Easycode`

---

## 一、仓库信息

| 项 | 值 |
|---|---|
| 仓库地址 | https://github.com/jk9988610/Easycode |
| SSH remote | `git@github.com:jk9988610/Easycode.git` |
| 主分支 | `main` |
| 本地路径 | `D:\Easycode` |
| 用户名 | `libin`（机器账号） |
| GitHub 账号 | `jk9988610` |

---

## 二、SSH 配置（已配好，一般不用动）

### 为什么走 443

默认 SSH 走 22 端口在国内常被 reset。配置走 `ssh.github.com:443` 稳定。

### 配置文件位置

```
C:\Users\libin\.ssh\config
```

### 内容

```
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile C:\Users\libin\.ssh\id_ed25519
    IdentitiesOnly yes
```

### 密钥

- 私钥：`C:\Users\libin\.ssh\id_ed25519`
- 公钥：`C:\Users\libin\.ssh\id_ed25519.pub`（已加到 GitHub Settings → SSH keys）

### 测试 SSH 连接

```powershell
ssh -T git@github.com -o ConnectTimeout=15
```

期望输出：

```
Hi jk9988610! You've successfully authenticated, but GitHub does not provide shell access.
```

出现 `Hi jk9988610!` 就代表连通。

---

## 三、日常推送流程

### 1. 提交（推荐用 devtool）

打开 devtool → 「Patch & Commit」tab：

1. 选 patch 脚本（如有）
2. 点「▶ Patch + Typecheck」
3. 填 commit 信息
4. 点「📝 提交」

### 2. 手动提交（命令行）

```powershell
cd D:\Easycode
git status
git add -A
git commit -m "feat(xxx): 描述"
```

### 3. 推送

```powershell
git push origin main
```

**普通 push 即可，不需要 `--force`。**

### 4. 验证

```powershell
git log origin/main --oneline -3
git diff origin/main --stat
```

第二条无输出 = 本地和远端一致。

---

## 四、提交信息规范

格式：`类型(模块): 描述`

| 类型 | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat(ui): 三色 overview ruler` |
| `fix` | 修 bug | `fix(agent): 修复 CRLF 匹配` |
| `docs` | 文档 | `docs: 更新 README` |
| `refactor` | 重构 | `refactor(renderer): 拆分 main.ts` |
| `chore` | 杂项 | `chore: gitignore 排除 patch-*.cjs` |

---

## 五、常见问题

### 问题 1：push 被拒（non-fast-forward）

远端有你本地没有的提交。

```powershell
git fetch origin
git log --oneline origin/main..HEAD   # 看本地多什么
git log --oneline HEAD..origin/main   # 看远端多什么
```

如果本地就是最新、远端有垃圾：

```powershell
git push --force origin main
```

### 问题 2：push 超时 / connection reset

HTTPS 被墙。改用 SSH（`git remote -v` 检查是不是 `git@github.com:...`）。

如果是 `https://...`，切换：

```powershell
git remote set-url origin git@github.com:jk9988610/Easycode.git
```

### 问题 3：SSH 报 `Permission denied (publickey)`

1. 检查 GitHub 上有公钥：https://github.com/settings/keys
2. 检查 `C:\Users\libin\.ssh\config` 里的 `IdentityFile` 路径对不对
3. 测：`ssh -T git@github.com`

### 问题 4：merge 后文件里出现 `<<<<<<<`

这是没真正解决的冲突标记。检查：

```powershell
git status
Select-String -Path (Get-ChildItem -Recurse -Include *.ts,*.py -File | Where-Object { $_.FullName -notmatch "node_modules|\.git" }) -Pattern "^<<<<<<<"
```

处理：找出干净的那个 commit，`git reset --hard <clean-commit>`。

### 问题 5：本地落后远端很多

```powershell
git fetch origin
git reset --hard origin/main   # 放弃本地改动，完全同步远端
```

---

## 六、应急恢复

### 找回被覆盖的提交

```powershell
git reflog -20
```

找到想要恢复的 commit hash：

```powershell
git reset --hard <hash>
```

### 完全重来（本地文件已备份）

```powershell
cd D:\Easycode
git fetch origin
git reset --hard origin/main
git clean -fd
```

---

## 七、历史事件记录

### 2026-10-10：仓库修复

**问题**：之前的 merge 产生了一个带冲突标记的坏 commit `b3d8429`，推到了远端。

**原因**：两份独立历史的仓库（一台机器 E 盘 vs 另一台 D 盘）用 `--allow-unrelated-histories` merge 时未真正解决冲突。

**修复**：

1. 找到干净的两个父 commit：`692ecb0`（我们做的）和 `f480f01`（Cursor AI 做的）
2. 确认 `f480f01` 干净且含双方全部功能
3. `git reset --hard f480f01`
4. `git push --force origin main` 覆盖远端

**结果**：本地 = 远端 = `f480f01`，冲突标记清除。

---

## 八、关键路径速查

| 用途 | 路径 |
|---|---|
| 项目根 | `D:\Easycode` |
| SSH 配置 | `C:\Users\libin\.ssh\config` |
| SSH 私钥 | `C:\Users\libin\.ssh\id_ed25519` |
| devtool | `D:\Easycode\devtool.py` |
| 开发启动 | `cd D:\Easycode && npm run dev` |

---

## 九、别做的事

- ❌ 不要把 API key（`sk-...`）提交进 git
- ❌ 不要在没备份的情况下 `git push --force`
- ❌ 不要在 PowerShell 里用 `Set-Content` 改含中文的源码（会坏 UTF-8）
- ❌ 不要同时在两个目录开发同一项目（这次冲突的根源）
- ❌ 不要用 `git pull --allow-unrelated-histories` 合并两份独立仓库，除非明确知道在做什么
