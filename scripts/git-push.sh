#!/usr/bin/env bash
# GitHub 投递（阶段 D）：凭据扫描门禁 → GIT_ASKPASS 临时脚本注入 PAT → push main
#
# 安全约定：
#   * 令牌从 /tmp/gh_token（0600）或 GITHUB_TOKEN 读取，不写入 .git/config、不回显
#   * GIT_ASKPASS 辅助脚本建在 /tmp（0600），push 结束（含失败）立即删除
#   * 提交前扫描历史里的 GitHub PAT / 私钥头（可用 COCOA_SECRET_PATTERN 追加自定义规则），命中即中止
#
# 用法：bash scripts/git-push.sh [--dry]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_SLUG="${GITHUB_REPO:-takwoo258-create/Cocoa}"
BRANCH="${GIT_BRANCH:-main}"
TOKEN_FILE="${GH_TOKEN_FILE:-/tmp/gh_token}"
DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

log()  { printf '\033[1;32m[git-push]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[git-push]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[git-push]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$ROOT"

[ -n "$(git rev-parse --git-dir 2>/dev/null)" ] || die "不是 git 仓库"

# ── 1. 敏感文件不得入库 ────────────────────────────────
log "检查暂存与历史中的敏感文件"
BAD_PATHS=$(git ls-files | grep -E '(^|/)(\.env|\.masterkey|\.admin-initial-password|key\.properties|.*\.jks|.*\.keystore|.*\.apk|.*\.aab)$|(^|/)(node_modules|data|deploy/backups)/|^build\.md$' || true)
if [ -n "$BAD_PATHS" ]; then
  warn "以下敏感/产物文件已被 git 跟踪，需先 git rm --cached："
  printf '%s\n' "$BAD_PATHS"
  die "中止：清理后再提交"
fi

# ── 2. 凭据扫描门禁（含全部历史）──────────────────────
log "扫描历史中的令牌/密码/私钥"
SCAN=$(git rev-list --all 2>/dev/null || true)
if [ -n "$SCAN" ]; then
  PATTERN="${COCOA_SECRET_PATTERN:-github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY}"
  HITS=$(git grep -nE "$PATTERN" $SCAN -- . ':!build.md' 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    warn "$HITS"
    die "历史中发现明文凭据，中止 push（请先 revoke 令牌并清理历史）"
  fi
fi

# ── 3. 远端状态探测 ───────────────────────────────────
log "探测远端 $REPO_SLUG"
REMOTE_URL="https://github.com/${REPO_SLUG}.git"
if git ls-remote --exit-code "$REMOTE_URL" >/dev/null 2>&1; then
  log "远端可访问（可能是空仓库或已有历史）"
else
  warn "远端不可访问或为空且无凭据读取（空仓库时 ls-remote 也返回成功）"
fi

[ "$DRY" = "1" ] && { log "--dry 结束"; exit 0; }

# ── 4. GIT_ASKPASS 注入 ───────────────────────────────
[ -f "$TOKEN_FILE" ] || die "找不到令牌文件 $TOKEN_FILE"
TOKEN="$(head -c 200 "$TOKEN_FILE" | tr -d '\n\r')"
[ -n "$TOKEN" ] || die "令牌文件为空"

ASKPASS="$(mktemp /tmp/cocoa-askpass.XXXXXX)"
cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT INT TERM
cat >"$ASKPASS" <<EOF
#!/usr/bin/env bash
case "\$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$TOKEN" ;;
  *) echo "" ;;
esac
EOF
chmod 700 "$ASKPASS"

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${REPO_SLUG}.git"
log "push 到 origin $BRANCH"
GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 git push -u origin "$BRANCH"

log "push 完成：$(git rev-parse --short HEAD) → $BRANCH"
log "远端：https://github.com/${REPO_SLUG}"
