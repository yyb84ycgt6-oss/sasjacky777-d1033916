#!/usr/bin/env bash
#
# Runs the migration chain against a throwaway PostgreSQL and then tries, as a
# second signed-in user, every cross-tenant move the security review asked us to
# prove impossible.
#
# The probes that matter run as the `authenticated` role, because that is the
# role a browser actually gets. Each runs in its own transaction: a refusal
# aborts the transaction it is in, and sharing one would turn the first refusal
# into a cascade of false passes for everything after it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGPORT="${PGPORT:-5433}"
PGHOST="${PGHOST:-/tmp}"
PGUSER="${PGUSER:-postgres}"
DB="${DB:-sasjacky_authz_test}"
PSQL_BASE=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER")

fail=0
pass=0

if ! "${PSQL_BASE[@]}" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
  echo "No PostgreSQL reachable at $PGHOST:$PGPORT — start one first." >&2
  echo "  initdb -D \$PGDATA -A trust -U postgres && pg_ctl -D \$PGDATA -o '-p $PGPORT -k /tmp' start" >&2
  exit 2
fi

echo "==> rebuilding $DB"
"${PSQL_BASE[@]}" -d postgres -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" >/dev/null

PSQL=("${PSQL_BASE[@]}" -d "$DB")

"${PSQL[@]}" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/00_supabase_shim.sql" >/dev/null || {
  echo "shim failed" >&2; exit 2; }

echo "==> applying migrations"
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  if ! out=$("${PSQL[@]}" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1); then
    # Two migrations in the existing history cannot apply to a fresh database.
    # Both are pre-existing defects, not regressions this suite tests for, and
    # both are superseded by later migrations that land the intended state:
    #
    #   ...180014  re-creates user_roles/app_role, already made by ...073000.
    #   ...181911  drops public.has_role while the audit_events policy still
    #              references it. Completed by 20260914120100.
    #
    # Anything else failing is a real break and stops the run.
    case "$(basename "$f")" in
      20260817180014_*|20260817181911_*)
        echo "    (tolerating known-broken $(basename "$f"))"
        continue
        ;;
    esac
    echo "MIGRATION FAILED: $(basename "$f")" >&2
    echo "$out" | grep -i error | head -3 >&2
    exit 2
  fi
done

echo "==> service-role and RPC probes"
if out=$("${PSQL[@]}" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/01_tenant_isolation.sql" 2>&1); then
  echo "$out" | grep -E '^ (svc|rate|unknown|rotation|double|rotating|provider)' || true
  pass=$((pass + 1))
else
  echo "$out" | tail -20
  echo "SERVICE-ROLE PROBES FAILED" >&2
  fail=$((fail + 1))
fi

# --- authenticated-role probes -------------------------------------------
A=aaaaaaaa-0000-0000-0000-000000000001
B=bbbbbbbb-0000-0000-0000-000000000002

probe() { # name | jwt sub | sql | expected substring
  local name="$1" sub="$2" sql="$3" want="$4" out res
  out=$("${PSQL[@]}" -tA 2>&1 <<EOF
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$sub';
$sql
ROLLBACK;
EOF
)
  res=$(echo "$out" | grep -viE '^(BEGIN|SET|ROLLBACK)$' | grep -v '^$' | head -1)
  if echo "$res" | grep -qF "$want"; then
    printf '  ok    %-46s %s\n' "$name" "$res"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-46s got:[%s] want:[%s]\n' "$name" "$res" "$want"
    fail=$((fail + 1))
  fi
}

echo "==> authenticated-role probes (user B against user A)"
probe "self-mint key with huge rate_limit" "$B" \
  "INSERT INTO public.api_keys (user_id,name,key_hash,prefix,rate_limit) VALUES ('$B','s','hash_s','p',999999);" \
  "permission denied"
probe "raise own rate_limit" "$B" \
  "UPDATE public.api_keys SET rate_limit=999999 WHERE user_id='$B';" "permission denied"
probe "delete own key row directly" "$B" \
  "DELETE FROM public.api_keys WHERE user_id='$B';" "permission denied"
probe "read another user's api_keys" "$B" \
  "SELECT count(*) FROM public.api_keys WHERE user_id='$A';" "0"
probe "read own api_keys still works" "$B" \
  "SELECT count(*) FROM public.api_keys;" "1"
probe "read another user's tasks" "$B" \
  "SELECT count(*) FROM public.jackie_tasks WHERE user_id='$A';" "0"
probe "update another user's task" "$B" \
  "WITH u AS (UPDATE public.jackie_tasks SET title='pwned' WHERE user_id='$A' RETURNING 1) SELECT count(*) FROM u;" "0"
probe "insert task owned by another user" "$B" \
  "INSERT INTO public.jackie_tasks (user_id,title) VALUES ('$A','forged');" "violates row-level security"
probe "read another user's memory" "$B" \
  "SELECT count(*) FROM public.jackie_memory WHERE user_id='$A';" "0"
probe "read another user's conversations" "$B" \
  "SELECT count(*) FROM public.conversations WHERE user_id='$A';" "0"
probe "insert bot_api_keys link directly" "$B" \
  "INSERT INTO public.bot_api_keys (bot_id,api_key_id,user_id) VALUES ('44444444-0000-0000-0000-00000000000b','22222222-0000-0000-0000-00000000000b','$B');" \
  "permission denied"
probe "insert usage log directly" "$B" \
  "INSERT INTO public.api_usage_logs (api_key_id,user_id,endpoint,status_code) VALUES ('22222222-0000-0000-0000-00000000000b','$B','/x',200);" \
  "permission denied"
probe "call consume_api_key" "$B" "SELECT public.consume_api_key('hash_b');" "permission denied"
probe "call rotate_api_key_atomic" "$B" \
  "SELECT public.rotate_api_key_atomic('$B','22222222-0000-0000-0000-00000000000b','h','p',now(),now(),false);" "permission denied"
probe "call consume_provider_quota" "$B" "SELECT public.consume_provider_quota('$B','x','y');" "permission denied"
probe "grant self the owner role" "$B" \
  "INSERT INTO public.user_roles (user_id,role) VALUES ('$B','owner');" "violates row-level security"
probe "public.is_admin removed from API" "$B" "SELECT public.is_admin('$B');" "does not exist"
probe "read api_key_rate_events" "$B" "SELECT count(*) FROM public.api_key_rate_events;" "permission denied"
probe "read xai_generation_requests" "$B" "SELECT count(*) FROM public.xai_generation_requests;" "permission denied"
probe "read provider_quota_policy" "$B" "SELECT count(*) FROM public.provider_quota_policy;" "permission denied"

echo
if [ "$fail" -gt 0 ]; then
  echo "FAILED: $fail probe group(s), $pass passed"
  exit 1
fi
echo "PASSED: $pass probe group(s)"
