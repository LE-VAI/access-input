"""Audit the published package: every shipped file vs every file reachable
through the exports map.

A file present in `files` but absent from `exports` is published yet
unimportable — the exact defect that made read-along.css unreachable. This
script is the check that catches that class at publish time instead of
letting an integrator hit an unresolvable import path.

Usage:  python scripts/audit-exports.py     (from the package root)

Exit 0 when nothing shipped-but-required is blocked, 1 otherwise, so it can be
wired into a publish step.

TWO CORRECTIONS over the first version of this script, both the same class of
bug it exists to find — an instrument that misreports:

1. `str.lstrip("./")` strips CHARACTERS, not a prefix. For a path like
   `./src/analog.js` it removes the leading dot and slash (fine by luck), but
   for a path that is exactly `./`-free or begins with a run of dots/slashes it
   silently mangles the name. Replaced with an explicit prefix removal.

2. The first version reported LICENSE and README.md as "unreachable", which is
   noise — those are conventional, fetched by tooling rather than imported, and
   reporting them trains a reader to ignore the output. Now classified
   separately as EXPECTED, so the blocked list means something.
"""
import json
import pathlib
import sys

# Conventionally fetched rather than imported — never a defect. Documentation
# is read by a person, not resolved by a bundler, so shipping it under `files`
# without an `exports` entry is correct rather than a gap. The earlier version
# of this list omitted docs/, which made every documentation file ship as a
# "SHIPPED BUT UNREACHABLE" failure and would have trained a reader to ignore
# the one report that matters.
EXPECTED_UNREACHABLE = {"LICENSE", "README.md", "package.json"}
EXPECTED_PREFIXES = ("docs/",)

# Internal modules are legitimately unreachable: nothing should import them
# directly, and exposing them would freeze implementation details as API.
#
# THIS LIST WAS HARDCODED FROM ANOTHER PACKAGE'S FILENAMES, which made the
# script silently wrong in any repo it was copied into — it would classify a
# real gap as "internal by design" and exit 0. Worse, here it names dwell.js,
# sources.js and analog.js, which THIS package does export: it is only harmless
# because the reachability check runs first. Anything not in the package's own
# exports belongs in the report, so the default is False and a name is added
# here only with a reason.
#
# Nothing is internal in this package today: every src/ module is either
# exported or reachable through the main entry. Keep it that way unless there
# is a specific module you intend to keep private.
INTERNAL = set()


def is_internal(path: str) -> bool:
    return path in INTERNAL


def unprefix(value: str) -> str:
    """Remove a leading './' once — not every leading dot and slash."""
    return value[2:] if value.startswith("./") else value


def collect_exports(node, out):
    """Walk the exports map, which may nest conditions (import/require/types)."""
    if isinstance(node, str):
        out.add(unprefix(node))
    elif isinstance(node, dict):
        for v in node.values():
            collect_exports(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_exports(v, out)


def main() -> int:
    d = json.load(open("package.json", encoding="utf-8"))
    reachable = set()
    collect_exports(d.get("exports", {}), reachable)

    shipped = []
    for pattern in d.get("files", []):
        p = pathlib.Path(pattern)
        if p.is_dir():
            shipped += [str(x).replace("\\", "/") for x in p.rglob("*") if x.is_file()]
        elif p.is_file():
            shipped.append(pattern)

    print(f"{d['name']}@{d['version']}")
    print()
    print(f"  shipped:                 {len(shipped)}")
    print(f"  reachable via exports:   {len(reachable)}")
    print()

    blocked, internal, expected = [], [], []
    for f in sorted(shipped):
        if f in reachable:
            continue
        if f in EXPECTED_UNREACHABLE or f.startswith(EXPECTED_PREFIXES):
            expected.append(f)
        elif is_internal(f):
            internal.append(f)
        else:
            blocked.append(f)

    if internal:
        print("  internal (unreachable by design):")
        for f in internal:
            print(f"     {f}")
        print()
    if expected:
        print("  conventional (fetched, not imported):")
        for f in expected:
            print(f"     {f}")
        print()

    if blocked:
        print("  SHIPPED BUT UNREACHABLE — these cannot be imported:")
        for f in blocked:
            print(f"     {f}")
        print()
        print("  Fix: add each to `exports` in package.json, or stop shipping it.")
        return 1

    print("  OK — nothing shipped is unreachable without a documented reason.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
