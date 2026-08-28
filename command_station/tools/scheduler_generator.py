#!/usr/bin/env python3
"""
Scheduler Generator — reads all tool files first, then generates scheduled tasks.
This fixes the workflow: read all tools → generate scheduler (no repeated triggers).
"""

import pathlib
from typing import List, Optional


def read_tool_files(tools_dir: str) -> dict[str, str]:
    """Read contents of all tool files in a directory."""
    results = {}
    for path in pathlib.Path(tools_dir).glob("*"):
        if path.is_file():
            try:
                results[path.name] = path.read_text(encoding="utf-8", errors="replace")
            except Exception as e:
                results[path.name] = f"ERROR reading {path}: {e}"
    return results


def scheduler_generation(tools_dir: str, vault_path: Optional[str] = None) -> dict:
    """
    Generate scheduled tasks after reading all tool files.

    This function is called AFTER read_tool_files() to ensure we have the full
    context of what tools are present before generating any schedules.
    """
    print("=" * 70)
    print("SCHEDULER GENERATION — Reading Tools First")
    print("=" * 70)

    tool_contents = read_tool_files(tools_dir)
    print(f"Found {len(tool_contents)} tools in {tools_dir}")

    if vault_path:
        print(f"Vault path: {vault_path}")

    # Example of generating a schedule entry for each tool
    schedules = []
    for name, content in sorted(tool_contents.items()):
        if "scheduler" not in name.lower():
            continue
        # Parse simple metadata from the file (e.g., frequency)
        freq = "daily"  # default; could be extracted from content
        schedules.append({
            "name": name,
            "frequency": freq,
            "content_preview": content[:200].strip() + "...",
        })

    print(f"\nGenerated {len(schedules)} schedule entries:")
    for s in schedules:
        print(f"  • {s['name']} — {s['frequency']}")

    return {"tool_contents": tool_contents, "schedules": schedules}


if __name__ == "__main__":
    import sys
    tools_dir = sys.argv[1] if len(sys.argv) > 1 else "C:/Users/Eru/AI_ Workspace/tools"
    vault_path = sys.argv[2] if len(sys.argv) > 2 else None
    result = scheduler_generation(tools_dir, vault_path)
    print("\nResult:")
    import json
    print(json.dumps(result, indent=2))
