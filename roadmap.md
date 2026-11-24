# Roadmap

## Guest security verification (Nov 20, 2026)
- [x] Re-scan security and review intentional guest ownership boundaries; informational notice reviewed as intended
- [x] Verify real guest chat and game saves, cross-guest isolation, and protected credentials
- [x] Repair and regression-test the rejected game cloud save; 25 related tests and preview build passed
- [x] Deep scan: fixed pod ownership and server-only cycle scores; owner prompt customization reviewed as intentional
- [ ] Critical connection destination finding remains active; own-account guards verified, broader destination safety not fully established
- [x] Sweep chat, archive, game background saves, and craft world saving for honest failures; craft cloud table absent, existing error handling verified in tests

## Security pass (Nov 2026) — done
- [x] Dependencies: patched versions resolved (scanner: 0 known issues); typecheck, 1,986 tests and build pass
- [x] Agent cycle touches only the caller's own agent
- [x] Game ledger: amounts and balances come from server rules, not the request
- [x] Model instructions: only the owner may replace Jackie's system prompt; others' text rides in the user turn
- [x] LAN relay: game-only origins, guests join only open worlds, code-guessing lockout, player cap
- [x] Bazar Stand: no client-side "verified" payment credits
- [x] Guests: cannot hold API keys or outside-service connections; other guest access stays own-rows-only

## Guest blocking (Nov 24, 2026 — operator decision)
- [ ] Block guests from saving anything: restrictive RLS on all app tables, readable "sign in to save" messaging, update guest-save tests, clear the anonymous-access scan notice

## Open
- [ ] Make offline checks evidence-based, add explicit local reply verification and a device-only report
- [ ] Complete bot integration and verify shared persona on every supported platform
- [ ] Spawn the nav diagonally at the upper right without covering inputs or controls
- [ ] Bazar Stand real payment verification + fulfilment (blocked: needs a payment provider decision; purchases currently wait and never complete)
- [ ] Game economy server-authoritative (diamonds/claims still live in the browser; ledger only audits)
- [ ] Offline photo question on Thinking Chain (blocked: needs a real GPU browser — the operator's RTX 3090)
- [ ] Workstation end to end (blocked: Jacky server rejects the saved token)
- [ ] Text/code converter in Jackie (Discord-style language picker, AI conversion)
