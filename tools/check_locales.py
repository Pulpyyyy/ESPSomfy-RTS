#!/usr/bin/env python3
"""Translation key integrity check for data-dev/locale/*.json.

The UI resolves every visible string through tr()/trf() or a tr= attribute, and a key
that is missing renders as the raw key -- or, for trf(), as a sentence with holes. None
of that fails the build, so it reaches the device silently. This checks:

  1. all locales expose the same key set (a key added to one file only)
  2. every key referenced from the HTML or the JS exists in every locale
  3. a key's {0}/{1} placeholders match across locales (trf would drop an argument)

Run standalone: python tools/check_locales.py
Exit code is non-zero on the first category that fails, so it can gate CI.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data-dev")
LOCALE_DIR = os.path.join(SRC, "locale")

# Only literal keys can be checked; tr(someVariable) is resolved at runtime and is
# deliberately out of scope rather than guessed at.
REFERENCE_PATTERNS = [
    re.compile(r'\btr-?(?:aria)?="([A-Z0-9_]+)"'),
    re.compile(r"\btrf?\(\s*'([A-Z0-9_]+)'"),
    re.compile(r'\btrf?\(\s*"([A-Z0-9_]+)"'),
]
PLACEHOLDER = re.compile(r"\{(\d+)\}")

# tr() falls back to the key itself, which makes an untranslated key a legitimate way to
# print a term that must stay identical in every language. MY is the name printed on the
# Somfy remote's middle button, not a label -- translating it would be the bug.
INTENTIONALLY_UNTRANSLATED = {"MY"}


def load_locales():
    locales = {}
    for name in sorted(os.listdir(LOCALE_DIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(LOCALE_DIR, name)
        with open(path, encoding="utf-8") as fh:
            locales[name[:-5]] = json.load(fh)
    return locales


def collect_references():
    refs = {}
    for folder, _dirs, files in os.walk(SRC):
        if os.path.basename(folder) == "locale":
            continue
        for name in files:
            if not name.endswith((".html", ".js")):
                continue
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            for pattern in REFERENCE_PATTERNS:
                for key in pattern.findall(text):
                    refs.setdefault(key, set()).add(os.path.relpath(path, ROOT))
    return refs


def main():
    locales = load_locales()
    if len(locales) < 2:
        print("no locales to compare")
        return 1
    failures = []

    reference = "en" if "en" in locales else sorted(locales)[0]
    base_keys = set(locales[reference])
    for lang, table in sorted(locales.items()):
        missing = base_keys - set(table)
        extra = set(table) - base_keys
        for key in sorted(missing):
            failures.append("%s: missing key %s (present in %s)" % (lang, key, reference))
        for key in sorted(extra):
            failures.append("%s: key %s absent from %s" % (lang, key, reference))

    refs = collect_references()
    for key, where in sorted(refs.items()):
        if key in INTENTIONALLY_UNTRANSLATED:
            continue
        for lang, table in sorted(locales.items()):
            if key not in table:
                failures.append(
                    "%s: %s referenced by %s has no translation"
                    % (lang, key, ", ".join(sorted(where)))
                )

    for key in sorted(base_keys):
        shapes = {}
        for lang, table in locales.items():
            if key in table:
                shapes.setdefault(
                    frozenset(PLACEHOLDER.findall(table[key])), []
                ).append(lang)
        if len(shapes) > 1:
            detail = "; ".join(
                "%s: {%s}" % (",".join(sorted(langs)), ",".join(sorted(shape)) or "none")
                for shape, langs in shapes.items()
            )
            failures.append("%s: placeholders differ between locales -- %s" % (key, detail))

    unused = sorted(base_keys - set(refs))
    if unused:
        # Informational: some keys are looked up through a variable, so an unused key is
        # a hint to check rather than a defect to fail on.
        print("note: %d keys are never referenced by a literal, e.g. %s"
              % (len(unused), ", ".join(unused[:8])))

    if failures:
        for line in failures:
            print("FAIL " + line)
        return 1
    print("locales OK: %d keys x %d languages, %d referenced from the UI"
          % (len(base_keys), len(locales), len(refs)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
