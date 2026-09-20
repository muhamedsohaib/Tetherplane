from pathlib import Path
import re
import sys

pattern = re.compile(r"\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)")
violations = []

for path in Path("agent").rglob("*.rs"):
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if pattern.search(line):
            violations.append(f"{path}:{number}:{line.strip()}")

if violations:
    print("Authored unsafe Rust detected:")
    print("\n".join(violations))
    sys.exit(1)

print("UNSAFE_SCAN_OK")
