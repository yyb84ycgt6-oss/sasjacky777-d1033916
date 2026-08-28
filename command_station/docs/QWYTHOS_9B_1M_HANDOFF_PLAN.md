# QWYTHOS-9B Claude Mythos 5 1M GGUF — Detailed Plan / Handoff

**Model Family:** QWYTHOS-9B  
**Variant:** Claude Mythos 5 1M context  
**Formats:** F16 (mmproj), Q4_K_M  
**Workstation:** C: primary, E: permanent vault  
**Last updated:** 2025-03-14

## 1. Current State Assessment

### Locations Identified
- **LM Studio source:** `C:\Users\Eru\AI_ Workspace\models\LM_Studio\Models\qwythos-9b-claude-mythos-5\`
  - `mmproj-Qwythos-9B-Claude-Mythos-5-F16.gguf` — 1,049 bytes (placeholder)
  - `mmproj-Qwythos-9B-Claude-Mythos-5-Q4_K_M.gguf` — 1,049 bytes (placeholder)
- **Permanent vault:** `E:\AI_Permanent\Models\qwythos-9b-claude-mythos-5-1m\gguf\`
  - `mmproj-Qwythos-9B-Claude-Mythos-5-1M-F16.gguf` — 918,165,472 bytes
  - `Qwythos-9B-Claude-Mythos-5-1M-Q4_K_M.gguf` — 5,629,108,896 bytes
- **Manifest reference:** `C:\Users\Eru\AI_ Workspace\docs\E_PERMANENT_MASTER_MANIFEST.json`
  - `lm_studio_path` = `C:\Users\Eru\AI_ Workspace\models\LM_Studio\Models\qwythos-9b-claude-mythos-5` ✓
  - `permanent_path` = `E:\AI_Permanent\Models\qwythos-9b-claude-mythos-5-1m\` ✓
  - `gguf_files` = `mmproj-Qwythos-9B-Claude-Mythos-5-1M-F16.gguf`, `Qwythos-9B-Claude-Mythos-5-1M-Q4_K_M.gguf` ✓
  - `workstation_config.storage_drives.lm_studio_models` = `C:\Users\Eru\AI_ Workspace\LMServer2012-08-30\Models` ✗ **Mismatch**

### Duplicate / Lineage Findings
- No byte-for-byte duplicate across C: and E:; source contains placeholder stubs, vault contains real weights.
- Naming drift: source uses `...-F16.gguf` / `...-Q4_K_M.gguf`; vault uses `...-1M-F16.gguf` / `...-1M-Q4_K_M.gguf`.
- Path drift: manifest config points to old `LMServer2012-08-30\Models` path for global config, while per-model entries are correct.

### Risk Assessment
- **Non-destructive:** Safe. No deletion proposed.
- **Reversible:** All moves logged via Robocopy logs + manifest versioning.
- **Path safety:** `AI_ Workspace` contains space — all scripts must quote paths. Engine/fs path_sanitizer already implemented.
- **Integrity:** SHA-256 checksums missing for real files; placeholder files will cause false positives if mirrored.

## 2. Reorganization Principles Applied

- Non-destructive — never delete unless explicitly ordered
- Reversible — every action logged, every move undoable
- Predictable — deterministic sorting rules
- Context-aware — respects Jackie_Rebuild, KEEP, MY HOME, Dev, AI boundaries
- Drive-wide clarity — remove duplicate sprawl, lineage confusion
- Workstation-grade — stable, quiet, efficient, no surprises

## 3. Proposed Actions for QWYTHOS-9B 1M

### Phase A — Manifest Correction
1. Update `workstation_config.storage_drives.lm_studio_models` to `C:\Users\Eru\AI_ Workspace\models\LM_Studio\Models`
2. Add explicit `source_placeholder` flag for LM Studio stubs to avoid false integrity failures.
3. Add `file_metadata` block with size and SHA-256 placeholders for vault files.

### Phase B — Integrity Baseline
1. Generate SHA-256 for both vault files:
   - `mmproj-Qwythos-9B-Claude-Mythos-5-1M-F16.gguf`
   - `Qwythos-9B-Claude-Mythos-5-1M-Q4_K_M.gguf`
2. Store checksums in `docs/GGUF_SHA256_Checksums.csv` and reference from manifest.
3. Run `vault_diff_tool.py` with ASCII-safe output to create baseline snapshot.

### Phase C — Mirror Strategy
- **Forward mirror** `C:\Users\Eru\AI_ Workspace\models\LM_Studio\Models\` → `E:\AI_Permanent\Models\`
  - Use `Robocopy_LMStudio_to_E.bat` with `/MIR /R:1 /W:1 /Z`
  - **Exclusion:** Skip placeholder files < 10KB to avoid overwriting real vault weights.
- **Reverse mirror** for restore path: `Robocopy_E_to_LMStudio.bat` with `/MIR` and manual confirmation.

### Phase D — Path Sanitization Integration
- All batch/PowerShell commands must use `safe()` quoting via `Jackie/core/engine/fs/path_sanitizer.py`
- Update `Robocopy_LMStudio_to_E.bat` to use quoted variables: `"%SOURCE_DIR%" "%DEST_DIR%"`
- Update `maintenance_orchestrator.bat` to import sanitized paths.

### Phase E — Memory Vault Population
- Memory vault pods for QWYTHOS-9B:
  - `context_chunks_QWYTHOS-9B_F16`
  - `context_chunks_QWYTHOS-9B_Q4_K_M`
- Retention: indefinite per user approval.
- Format: jsonl/bin.
- Populate with sample chunks already present in `docs/memory_vault_samples/`; migrate to `E:\AI_Permanent\Models\qwythos-9b-claude-mythos-5-1m\memory_vault\`

### Phase F — Hybrid Routing Config
- GPU: QWYTHOS-9B Claude Mythos 5 1M FP16/Q4_K_M — main brain
- CPU threads: 32, KV cache offload to DRAM, max context 262144
- Fallback chain: QWYTHOS-9B → Qwen2-7B
- Router entry in `hybrid_router.py:QWYTHOS_CONFIG` verified.

## 4. Configuration Files to Generate / Update

- `C:\Users\Eru\AI_ Workspace\docs\E_PERMANENT_MASTER_MANIFEST.json` — correct `lm_studio_models` path
- `C:\Users\Eru\AI_ Workspace\tools\Robocopy_LMStudio_to_E.bat` — add exclusion for placeholder files
- `C:\Users\Eru\AI_ Workspace\tools\Robocopy_E_to_LMStudio.bat` — reverse mirror fallback
- `C:\Users\Eru\AI_ Workspace\tools\hybrid_router.py` — ensure QWYTHOS config points to permanent vault paths
- `C:\Users\Eru\AI_ Workspace\tools\integrity_dashboard.py` — add QWYTHOS-9B checks
- `C:\Users\Eru\AI_ Workspace\Jackie\core\engine\fs\` — already implemented; integrate into tool runners

## 5. Validation Checklist

- [ ] Manifest path corrected and version bumped
- [ ] SHA-256 checksums generated for both GGUF files
- [ ] Vault diff baseline created with ASCII-safe output
- [ ] Robocopy forward mirror runs without overwriting real weights
- [ ] Path sanitization applied to all batch scripts
- [ ] Memory vault pods created under permanent vault
- [ ] Hybrid router test suite passes for QWYTHOS
- [ ] Task Scheduler nightly maintenance configured at 02:00

## 6. Operational Notes

- Do **not** replace placeholder LM Studio files with vault weights automatically; LM Studio may manage its own downloads. Keep vault as source of truth.
- Use E: for permanent long-term contextual large podded memory partitions to reduce write/erase cycles.
- All actions logged to `C:\Users\Eru\AI_ Workspace\logs\` with timestamps.
- Undo procedure: restore from Robocopy logs + manifest previous version.

## 7. Handoff to Next Agent

Current work completed:
- Engine/fs path sanitization layer implemented
- Tools suite created: test_router_suite, integrity_dashboard, vault_diff_tool, maintenance_orchestrator
- Memory vault samples created
- Permanent vault partially populated

Immediate next steps:
1. Correct manifest `lm_studio_models` path
2. Generate SHA-256 for vault GGUF files
3. Run vault diff baseline
4. Update Robocopy scripts with path sanitization and placeholder exclusion
5. Setup Task Scheduler nightly maintenance
6. Test hybrid router with real QWYTHOS files

No deletions required. All operations reversible and logged.

---
**Owner:** System Organizer AI  
**Model:** QWYTHOS-9B Claude Mythos 5 1M GGUF  
**Status:** Plan ready for execution
