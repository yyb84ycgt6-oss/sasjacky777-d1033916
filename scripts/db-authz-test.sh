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
probe "read another user's BlockCraft worlds" "$B" \
  "SELECT count(*) FROM public.craft_worlds WHERE user_id='$A';" "0"
probe "overwrite another user's BlockCraft world" "$B" \
  "WITH u AS (UPDATE public.craft_worlds SET data='x' WHERE user_id='$A' RETURNING 1) SELECT count(*) FROM u;" "0"
probe "delete another user's BlockCraft world" "$B" \
  "WITH d AS (DELETE FROM public.craft_worlds WHERE user_id='$A' RETURNING 1) SELECT count(*) FROM d;" "0"
probe "upload a world under another user's id" "$B" \
  "INSERT INTO public.craft_worlds (id,user_id,name,summary,data) VALUES ('wB','$A','x','{}','{}');" \
  "violates row-level security"
probe "upload own world still works" "$B" \
  "INSERT INTO public.craft_worlds (id,user_id,name,summary,data) VALUES ('wB','$B','Mine','{}','{}') RETURNING id;" "wB"
probe "backdate own world to win a sync" "$B" \
  "INSERT INTO public.craft_worlds (id,user_id,name,summary,data,updated_at) VALUES ('wC','$B','Mine','{}','{}','3000-01-01') RETURNING updated_at < '2999-01-01';" "t"

# --- Jackie's morals guard rail ----------------------------------------------
# Same shape as probe(), with user A holding the owner seat for the duration of
# the transaction, so the owner's own powers are probed as well as everyone
# else's lack of them. A ledger the owner account could quietly rewrite would
# guard against everyone except the one account whose theft matters most.
probe_as_owner() { # name | sql | expected substring
  local name="$1" sql="$2" want="$3" out res
  out=$("${PSQL[@]}" -tA 2>&1 <<EOF
BEGIN;
INSERT INTO public.user_roles (user_id, role) VALUES ('$A', 'owner') ON CONFLICT DO NOTHING;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$A';
$sql
ROLLBACK;
EOF
)
  res=$(echo "$out" | grep -viE '^(BEGIN|SET|ROLLBACK|INSERT 0 [01]|CONTEXT: .*)$' | grep -v '^$' | tail -1)
  if echo "$res" | grep -qF "$want"; then
    printf '  ok    %-46s %s\n' "$name" "$res"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-46s got:[%s] want:[%s]\n' "$name" "$res" "$want"
    fail=$((fail + 1))
  fi
}

# The service role bypasses grants and RLS; these show the triggers still hold.
svc() {
  "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL ROLE service_role; $1; ROLLBACK;" 2>&1 \
    | grep -viE '^(BEGIN|SET|ROLLBACK|INSERT 0 1|UPDATE [0-9]+|CONTEXT: .*)$' | grep -v '^$' | tail -1
}
check() { # name | got | expected substring
  if echo "$2" | grep -qF "$3"; then
    printf '  ok    %-46s %s\n' "$1" "$2"; pass=$((pass + 1))
  else
    printf '  FAIL  %-46s got:[%s] want:[%s]\n' "$1" "$2" "$3"; fail=$((fail + 1))
  fi
}

echo "==> morals guard rail"
probe "non-owner reads morals" "$B" "SELECT count(*) FROM public.jackie_morals;" "0"
probe "non-owner writes a moral" "$B" \
  "INSERT INTO public.jackie_morals (title, rule) VALUES ('x', 'lie freely');" "violates row-level security"
probe "non-owner reads the ledger" "$B" "SELECT count(*) FROM public.jackie_morals_ledger;" "0"
probe "non-owner reads attestations" "$B" "SELECT count(*) FROM public.jackie_persona_attestations;" "0"
probe "forge an engine attestation" "$B" \
  "SELECT public.record_persona_attestation('jackie-chat','persona','f','none',null);" "permission denied"
probe "seal as yourself" "$B" "SELECT public.jackie_morals_seal('$B', '{}');" "permission denied"
probe "call the ledger append directly" "$B" \
  "SELECT private.jackie_morals_append('seal', null, '{}', '$B');" "permission denied"
probe_as_owner "owner adds a moral" \
  "INSERT INTO public.jackie_morals (title, rule) VALUES ('Keep promises', 'Do what you said.') RETURNING title;" \
  "Keep promises"
probe_as_owner "owner's change lands in the ledger" \
  "INSERT INTO public.jackie_morals (title, rule) VALUES ('a', 'b'); SELECT action || ':' || (actor = '$A') FROM public.jackie_morals_ledger ORDER BY seq DESC LIMIT 1;" \
  "create:true"
probe_as_owner "owner edits a ledger entry" \
  "INSERT INTO public.jackie_morals (title, rule) VALUES ('a', 'b'); UPDATE public.jackie_morals_ledger SET payload = '{}';" \
  "permission denied"
probe_as_owner "owner deletes a ledger entry" \
  "INSERT INTO public.jackie_morals (title, rule) VALUES ('a', 'b'); DELETE FROM public.jackie_morals_ledger;" \
  "permission denied"
probe_as_owner "owner inserts a ledger entry directly" \
  "INSERT INTO public.jackie_morals_ledger (seq, action, payload, prev_hash, hash) VALUES (99, 'seal', '{}', 'x', 'y');" \
  "permission denied"
probe_as_owner "owner seals through the API" "SELECT public.jackie_morals_seal('$A', '{}');" "permission denied"
probe_as_owner "a 25th moral is refused" \
  "INSERT INTO public.jackie_morals (title, rule) SELECT 'm' || g, 'r' FROM generate_series(1, 25) g;" \
  "at most 24 morals"
probe_as_owner "a rule longer than the cap is refused" \
  "INSERT INTO public.jackie_morals (title, rule) VALUES ('long', repeat('x', 281));" "violates check constraint"
check "service role edits the ledger" \
  "$(svc "INSERT INTO public.jackie_morals (title, rule) VALUES ('a','b'); UPDATE public.jackie_morals_ledger SET payload='{}'")" \
  "append-only"
check "service role truncates the ledger" "$(svc "TRUNCATE public.jackie_morals_ledger")" "append-only"
check "a write from no account is attributed to nobody" \
  "$(svc "INSERT INTO public.jackie_morals (title, rule) VALUES ('a','b'); SELECT coalesce(actor::text, 'nobody') FROM public.jackie_morals_ledger ORDER BY seq DESC LIMIT 1")" \
  "nobody"
check "each entry hashes the one before it" \
  "$(svc "INSERT INTO public.jackie_morals (title, rule) VALUES ('a','b'); UPDATE public.jackie_morals SET rule='c'; DELETE FROM public.jackie_morals; SELECT count(*) || ':' || bool_and(ok) FROM (SELECT hash = encode(sha256(convert_to(prev_hash || E'\n' || seq::text || E'\n' || action || E'\n' || payload, 'UTF8')), 'hex') AND prev_hash = coalesce(lag(hash) OVER (ORDER BY seq), 'genesis') AS ok FROM public.jackie_morals_ledger) l")" \
  "3:t"
check "the service role can record an attestation" \
  "$(svc "SELECT public.record_persona_attestation('jackie-chat','persona','f','none',null); SELECT public.record_persona_attestation('jackie-chat','persona','f','none',null); SELECT requests FROM public.jackie_persona_attestations")" \
  "2"

echo
if [ "$fail" -gt 0 ]; then
  echo "FAILED: $fail probe group(s), $pass passed"
  exit 1
fi
echo "PASSED: $pass probe group(s)"
