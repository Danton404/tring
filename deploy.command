#!/bin/zsh
# Double-click to publish TRING: commits and pushes everything to GitHub,
# then deploys the Supabase Edge Functions if they changed.

PROJECT_REF="rqmybqdyfsrnkmbvaadx"
cd "${0:A:h}" || exit 1

finish() { echo; read -k1 "?Press any key to close..."; exit ${1:-0}; }

echo "== TRING deploy =="
echo

# ---------- GitHub
# Commits need an identity; fall back to the GitHub no-reply address if none is set
if [[ -z $(git config user.email) ]]; then
  git config user.name "Daniel Petrov Tonchev"
  git config user.email "271995284+Danton404@users.noreply.github.com"
fi
git fetch -q origin main 2>/dev/null
before=$(git rev-parse -q --verify origin/main)

if [[ -n $(git status --porcelain) ]]; then
  git status --short
  echo
  read "msg?Commit message (Enter for default): "
  [[ -z $msg ]] && msg="Update $(date '+%Y-%m-%d %H:%M')"
  git add -A && git commit -q -m "$msg" || { echo "Commit failed."; finish 1; }
fi

git pull -q --rebase origin main || { echo "Pull failed. Fix the conflict, then run again."; finish 1; }
git push -q origin main || { echo "Push failed."; finish 1; }
echo "GitHub: pushed to origin/main ($(git rev-parse --short HEAD))."

# ---------- Supabase
changed=$( [[ -n $before ]] && git diff --name-only "$before" HEAD -- supabase || git ls-files supabase )
fns=(${(u)$(echo "$changed" | sed -n 's#^supabase/functions/\([^/]*\)/.*#\1#p')})

echo
if (( ${#fns} == 0 )); then
  echo "Supabase: no function changes, nothing to deploy."
elif ! command -v supabase >/dev/null; then
  echo "Supabase: functions changed (${fns[*]}) but the Supabase CLI isn't installed."
  echo "  Install once:  brew install supabase/tap/supabase && supabase login"
  echo "  Or paste the code into Supabase > Edge Functions by hand."
else
  for fn in $fns; do
    echo "Supabase: deploying $fn..."
    supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt || echo "  Deploy of $fn failed (run 'supabase login' if you're not signed in)."
  done
fi

if echo "$changed" | grep -q '^supabase/schema.sql$'; then
  echo "Supabase: schema.sql changed. Re-run it in Supabase > SQL Editor (safe to re-run)."
fi

finish 0
