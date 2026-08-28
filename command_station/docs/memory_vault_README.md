# MEMORY VAULT PODS — DOCUMENTATION

## Overview

The Memory Vault is a permanent, partial-partition storage system for context chunks and embeddings that enables:
- **Reduced write/erase cycles** through partial partitions
- **No overlapping data** — each chunk belongs to exactly one pod
- **Deterministic organization** with clear lineage tracking
- **Indefinite retention** policy for long-term context preservation

## Directory Structure

```
E:\AI_Permanent\Models\
├── QWYTHOS-9B\
│   ├── F16\
│   │   └── context_chunks_QWYTHOS-9B_F16_001.jsonl
│   └── Q4_K_M\
│       └── context_chunks_QWYTHOS-9B_Q4_K_M_001.jsonl
├── Muse-Glimmer-30B\
│   ├── context_chunks_Muse-Glimmer-30B_001.jsonl
│   └── embedding_pods_Muse-Glimmer-30B_001.jsonl
├── GPT-OSS\
│   ├── context_chunks_GPT-OSS_001.jsonl
│   └── embedding_pods_GPT-OSS_001.jsonl
├── Qwen2-7B\
│   ├── context_chunks_Qwen2-7B_001.jsonl
│   └── embedding_pods_Qwen2-7B_001.jsonl
├── Llama3-8B\
│   ├── context_chunks_Llama3-8B_001.jsonl
│   └── embedding_pods_Llama3-8B_001.jsonl
├── Mistral-7B\
│   ├── context_chunks_Mistral-7B_001.jsonl
│   └── embedding_pods_Mistral-7B_001.jsonl
└── Phi-3-mini\
    ├── context_chunks_Phi-3-mini_001.jsonl
    └── embedding_pods_Phi-3-mini_001.jsonl
```

## Sample Files Location

Sample context chunks are available in:
`C:\Users\Eru\AI_ Workspace\docs\memory_vault_samples\`

These demonstrate the format and structure for populating the actual vault.

## Context Chunk Format

Each context chunk follows this JSONL structure:

```json
{
  "chunk_id": "chk_qwythos_f16_001",
  "model_family": "QWYTHOS-9B",
  "quantization": "F16",
  "timestamp": "2025-03-14T10:30:00Z",
  "source": "conversation_thread_system_architecture",
  "context_length": 8192,
  "embedding_hash": "a1b2c3d4e5f6789012345678901234567890123",
  "content_preview": "System architecture design patterns for hybrid CPU/GPU/DRAM routing...",
  "metadata": {
    "topic": "system_architecture",
    "confidence": 0.97,
    "retention_tier": "gold",
    "pod_partition": 1
  }
}
```

## Retention Tiers

- **Platinum**: Critical system architecture, permanent reference
- **Gold**: Important operational knowledge, long-term retention
- **Silver**: Useful contextual information, medium-term retention
- **Bronze**: Temporary or low-priority information, short-term retention

## Pod Partitioning

- **Partition size**: 100 chunks per pod
- **Automatic rotation**: When a pod reaches 100 chunks, a new partition is created
- **Naming convention**: `context_chunks_<model_family>_<quantization>_<partition>.jsonl`

## Integration with Hybrid Router

The memory vault integrates with `hybrid_router.py` through:

```python
router_config = {
  "memory_vault_active": True,
  "context_stitching_enabled": True,
  "vault_path": "E:\\AI_Permanent\\Models\\",
  "pod_partition_size": 100,
  "deduplication_enabled": True
}
```

## Deduplication

- **Method**: SHA-256 hashing of chunk content
- **Verification**: Integrity checks run daily at 02:00 AM
- **Conflict resolution**: Keep newest version, archive older versions

## Backup Policy

- **Type**: Indefinite retention
- **Daily sync**: Automatic forward mirror from LM Studio to E:
- **Weekly verification**: Integrity checks and deduplication
- **Logging**: All operations logged with timestamps

## Usage Examples

### Retrieve context chunks for a model family

```bash
# Find all chunks for QWYTHOS-9B F16
find E:\AI_Permanent\Models\QWYTHOS-9B\F16\ -name "context_chunks*.jsonl"
```

### Generate embeddings from context chunks

```python
from hybrid_router import MemoryVaultLoader
loader = MemoryVaultLoader("E:\\AI_Permanent\\Models\\")
chunks = loader.load_model_chunks("QWYTHOS-9B", "F16")
embeddings = loader.generate_embeddings(chunks)
```

### Verify vault integrity

```bash
# Run SHA-256 verification
python tools\verify_vault_integrity.py E:\AI_Permanent\Models\
```

## Maintenance

1. **Daily**: Automatic sync via Task Scheduler at 02:00 AM
2. **Weekly**: Manual integrity verification and deduplication
3. **Monthly**: Review retention tiers and archive old bronze-tier chunks

## Best Practices

1. **Never modify chunks manually** — always use the router API
2. **Monitor pod sizes** — keep partitions under 100 chunks
3. **Regular deduplication** — prevents overlapping data
4. **Backup verification** — confirm forward mirror is working
5. **Document changes** — log all modifications to vault structure

## Troubleshooting

**Issue**: Chunks not loading in router
**Solution**: Verify chunk format matches JSONL schema and embedding_hash is present

**Issue**: Pod size exceeds 100 chunks
**Solution**: Create new partition and update manifest

**Issue**: Duplicate chunks detected
**Solution**: Run deduplication script and verify SHA-256 hashes

---

*Generated: 2025-03-14*
*Workstation Configuration: 24GB VRAM, 16 cores, 128GB DRAM*
