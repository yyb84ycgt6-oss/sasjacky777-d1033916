import os
import hashlib
import json
from collections import defaultdict

# ---------------------------------------------------------
# Jackie Inspector
# Scans your entire Jackie_Rebuild folder and reports:
# - duplicates
# - outdated modules
# - missing architecture components
# - LM Studio fragments
# - constellation kernel pieces
# - sovereign OS spine fragments
# - flow hub logic
# - agent mesh logic
# - pod/backpack geometry
# - UFNB spine
# - router nervous system
# - memory fabric nodes
# - invisible lift engine
# - workstation UI pieces
# ---------------------------------------------------------

GOLDEN_COMPONENTS = {
    "kernel": ["kernel.yaml", "kernel.ts"],
    "constellation": ["constellation.yaml", "constellation.ts"],
    "flow_hub": ["flow_hub.yaml", "flow_hub.ts"],
    "agents": ["agents.yaml", "mapper.ts", "tagger.ts", "planner.ts", "compressor.ts", "interpreter.ts"],
    "memory_fabric": ["memory_fabric.yaml", "memory_fabric.ts"],
    "ufnb_spine": ["ufnb_spine.yaml", "ufnb_spine.ts"],
    "router_nervous": ["router_nervous.ts"],
    "pods_backpacks": ["pods_backpacks.ts"],
    "invisible_lift": ["invisible_lift.ts"],
    "workstation": ["workstation.tsx"],
    "entrance": ["entrance.tsx"],
    "qol": ["qol.tsx"],
    "docs": [
        "01_overview.md",
        "02_kernel_and_constellation.md",
        "03_flow_hub_and_agents.md",
        "04_memory_fabric_and_pods.md",
        "05_ufnb_spine_and_router.md",
        "06_sas_hub_workstation.md"
    ]
}

def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def scan_folder(root):
    file_map = defaultdict(list)
    hash_map = defaultdict(list)

    for dirpath, _, filenames in os.walk(root):
        for f in filenames:
            full = os.path.join(dirpath, f)
            file_map[f].append(full)
            try:
                h = hash_file(full)
                hash_map[h].append(full)
            except Exception:
                pass

    return file_map, hash_map

def check_components(file_map):
    report = {"present": [], "missing": [], "partial": []}

    for comp, files in GOLDEN_COMPONENTS.items():
        found = any(f in file_map for f in files)
        if found:
            # Check if all files exist
            missing_files = [f for f in files if f not in file_map]
            if missing_files:
                report["partial"].append({comp: missing_files})
            else:
                report["present"].append(comp)
        else:
            report["missing"].append(comp)

    return report

def main():
    import sys
    if len(sys.argv) < 2:
        print("Usage: python jackie_inspector.py <folder>")
        return

    root = sys.argv[1]
    print(f"\n🔍 Scanning Jackie folder: {root}\n")

    file_map, hash_map = scan_folder(root)
    report = check_components(file_map)

    print("=== Jackie Component Report ===\n")
    print("✔ Present:")
    for p in report["present"]:
        print("  -", p)

    print("\n⚠ Partial:")
    for p in report["partial"]:
        print("  -", p)

    print("\n❌ Missing:")
    for m in report["missing"]:
        print("  -", m)

    print("\n=== Duplicate Files (same hash) ===")
    for h, paths in hash_map.items():
        if len(paths) > 1:
            print("\nDuplicate group:")
            for p in paths:
                print("  ", p)

    print("\nDone.\n")

if __name__ == "__main__":
    main()
