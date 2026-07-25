
import gzip
import os
import re
import shutil
import json
from SCons.Script import Import

Import("env")

# ──────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────
SRC_DIR_NAME = "data-dev"
DST_DIR_NAME = "data"

# Extensions à traiter (Minify + Gzip)
MINIFY_AND_GZIP = {".html", ".htm", ".css", ".js", ".json", ".svg", ".xml"}

def _project_dir():
    return env.subst("$PROJECT_DIR")

def _src_dir():
    return os.path.join(_project_dir(), SRC_DIR_NAME)

def _dst_dir():
    return os.path.join(_project_dir(), DST_DIR_NAME)

# ──────────────────────────────────────────────
# Minificateurs
# ──────────────────────────────────────────────

def minify_html(text: str) -> str:
    # Stash inline <script>/<pre>/<textarea> blocks: their whitespace is significant
    # (a string literal with 2+ spaces would be corrupted by the collapse below).
    protected = []
    def stash(m):
        protected.append(m.group(0))
        return f"\x00{len(protected) - 1}\x00"
    text = re.sub(r"<(script|pre|textarea)\b[^>]*>.*?</\1>", stash, text,
                  flags=re.DOTALL | re.IGNORECASE)
    # Strip HTML comments (the previous empty pattern was a no-op), but keep IE
    # conditional comments intact.
    text = re.sub(r"<!--(?!\[if).*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r">\s+<", "> <", text)
    text = re.sub(r"\s{2,}", " ", text)
    text = text.strip()
    for i, block in enumerate(protected):
        text = text.replace(f"\x00{i}\x00", block, 1)
    return text

# A single scanner for the CSS constructs whose contents are literal data:
# comments, quoted strings and url() tokens. Ordering matters - a comment is
# matched before a string so that a quote inside a comment cannot open a bogus
# string, and url() is matched last so a quoted url is handled by the string
# branch of the alternation inside it.
_CSS_LITERALS = re.compile(
    r"""
      /\*.*?\*/                                    # comment
    | "(?:\\.|[^"\\\n])*"                          # double quoted string
    | '(?:\\.|[^'\\\n])*'                          # single quoted string
    | url\(\s*(?:"(?:\\.|[^"\\\n])*"
              |'(?:\\.|[^'\\\n])*'
              |[^)"'\n]*)\s*\)                     # url(), quoted or bare
    """,
    re.DOTALL | re.VERBOSE | re.IGNORECASE,
)

def minify_css(text: str) -> str:
    # 1. Mettre de côté commentaires, chaînes et url() : les règles de
    # compactage ci-dessous ne doivent JAMAIS s'appliquer à l'intérieur d'une
    # valeur littérale. Sans cela `content: "a, b"` devenait `content:"a,b"` et
    # les data-URI SVG de url(...) étaient tronqués sur leurs `:` et `;`.
    literals = []

    def stash(m):
        token = m.group(0)
        if token.startswith("/*"):  # commentaire : supprimé, pas conservé
            return " "
        literals.append(token)
        return f"\x00{len(literals) - 1}\x00"

    text = _CSS_LITERALS.sub(stash, text)

    # 2. Remplacer les retours à la ligne et tabulations par des espaces simples
    text = re.sub(r"\s+", " ", text)

    # 3. Supprimer les espaces inutiles autour des caractères de structure CSS
    text = re.sub(r"\s*([:{};,])\s*", r"\1", text)

    # 4. ASTUCE POUR FIREFOX : On isole les règles -webkit- en réinjectant un espace
    # après chaque fermeture d'accolade qui les concerne pour casser le bloc unique.
    text = re.sub(r"([^{]*?-webkit-[^}]+})", r"\1\n", text)

    text = text.strip()

    # 5. Réinjecter les littéraux intacts.
    for i, token in enumerate(literals):
        text = text.replace(f"\x00{i}\x00", token, 1)
    return text

def minify_js(text: str) -> str:
    return text

def minify_json(text: str) -> str:
    try:
        data = json.loads(text)
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    except:
        return text

def minify_svg(text: str) -> str:
    # Strip XML/SVG comments (the previous empty pattern removed nothing).
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    return re.sub(r">\s+<", "><", text).strip()

MINIFIERS = {
    ".html": minify_html,
    ".htm":  minify_html,
    ".css":  minify_css,
    ".js":   minify_js,
    ".json": minify_json,
    ".svg":  minify_svg,
    ".xml":  minify_svg,
}

# ──────────────────────────────────────────────
# Logique de traitement
# ──────────────────────────────────────────────

def process_file(src_path: str, dst_path: str):
    ext = os.path.splitext(src_path)[1].lower()
    original_size = os.path.getsize(src_path)

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)

    # Traitement Textes (Minify + Gzip)
    if ext in MINIFY_AND_GZIP:
        with open(src_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()

        minifier = MINIFIERS.get(ext)
        if minifier:
            content = minifier(content)
            action = "minify+gzip"
        else:
            action = "gzip"

        gz_path = dst_path + ".gz"
        # Reproducible output: gzip.open() stamps the current time and the
        # member name into the header, so two builds of an identical source
        # produced two different .gz files (and therefore a different
        # littlefs.bin). mtime=0 and an empty filename remove both.
        with open(gz_path, "wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw,
                               compresslevel=9, mtime=0) as gz:
                gz.write(content.encode("utf-8"))

        final_size = os.path.getsize(gz_path)
        return action, original_size, final_size

    shutil.copy2(src_path, dst_path)
    return "copy", original_size, original_size

def minify_all():
    src_dir = _src_dir()
    dst_dir = _dst_dir()

    if not os.path.isdir(src_dir):
        return

    if os.path.exists(dst_dir):
        shutil.rmtree(dst_dir)
    os.makedirs(dst_dir, exist_ok=True)

    print(f"\n[minify] Optimisation des assets : {SRC_DIR_NAME} -> {DST_DIR_NAME}")

    for root, dirs, files in os.walk(src_dir):
        for fname in sorted(files):
            if fname.startswith(".") or fname.endswith("~"): continue

            src_path = os.path.join(root, fname)
            rel_path = os.path.relpath(src_path, src_dir)
            dst_path = os.path.join(dst_dir, rel_path)

            action, old_sz, new_sz = process_file(src_path, dst_path)

            saved = old_sz - new_sz
            pct = (saved / old_sz * 100) if old_sz > 0 else 0
            print(f"  {rel_path:<30} {old_sz:>7} -> {new_sz:>7} B ({pct:>3.0f}%) [{action}]")

# Lancement
minify_all()
