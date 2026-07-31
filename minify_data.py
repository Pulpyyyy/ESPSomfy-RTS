
import gzip
import hashlib
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

# Cache-busting token per bundle, derived from the bundle's own bytes and
# filled in by concat_*_chunks below. The bundles are served immutable for a
# year, so the token in the URL is the only thing that can invalidate them:
# keyed on the release version, as it used to be, any change shipped between
# two releases reached browsers still holding the previous bundle - new HTML
# driving old JavaScript, which is exactly what a stale service worker then
# fights over. Content-keyed, a change always lands on a new URL.
_ASSET_VER = {}

def _content_ver(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]

def merge_js_tags(text: str) -> str:
    # data-dev keeps the app JS as ordered chunks under js/ so the sources stay
    # editable, while the firmware serves ONE /index.js: collapse the chunk tags
    # into a single index.js tag here; minify_all() concatenates the chunk files
    # into the matching index.js.gz.
    tags = re.findall(r'<script\s+src="js/[^"]+"></script>\s*', text)
    if not tags:
        return text
    m = re.search(r'\?v=([^"]+)"', tags[0])
    ver = _ASSET_VER.get("js") or (m.group(1) if m else "")
    ver = f"?v={ver}" if ver else ""
    text = text.replace(tags[0], f'<script src="index.js{ver}"></script>\n', 1)
    for t in tags[1:]:
        text = text.replace(t, "", 1)
    # Fail the build loudly if any chunk reference survived (an attribute added to a
    # tag, quoting changed...): the js/ directory is never shipped, so a leftover
    # tag would 404 in production with no other symptom.
    if 'src="js/' in text:
        raise RuntimeError("merge_js_tags: a js/ chunk tag did not match the merge pattern")
    return text

# Stylesheets shipped as ONE app.css: order matters, base holds the tokens the
# other two build on (the cascade must stay base -> main -> overlays).
CSS_CHUNKS = ("base.css", "main.css", "overlays.css")

def merge_css_tags(text: str) -> str:
    # Same idea as merge_js_tags: dev mode keeps three <link> tags, production
    # collapses them into a single app.css matching the concatenated gzip.
    tags = []
    for name in CSS_CHUNKS:
        m = re.search(r'<link\s+rel="stylesheet"\s+href="%s(\?v=[^"]*)?">\s*' % re.escape(name), text)
        if m:
            tags.append(m)
    if not tags:
        return text
    if len(tags) != len(CSS_CHUNKS):
        raise RuntimeError("merge_css_tags: index.html references only part of %s" % (CSS_CHUNKS,))
    ver = "?v=%s" % _ASSET_VER["css"] if _ASSET_VER.get("css") else (tags[0].group(1) or "")
    text = text.replace(tags[0].group(0), '<link rel="stylesheet" href="app.css%s">\n' % ver, 1)
    for m in tags[1:]:
        text = text.replace(m.group(0), "", 1)
    for name in CSS_CHUNKS:
        if 'href="%s' % name in text:
            raise RuntimeError("merge_css_tags: a stylesheet tag did not match the merge pattern")
    return text

def minify_html(text: str) -> str:
    text = merge_js_tags(text)
    text = merge_css_tags(text)
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

_JS_BS = chr(92)

def minify_js(text: str) -> str:
    """Strip comments and layout from JS, keeping every token byte for byte.

    Sources under data-dev/js keep their comments; only the bundle the board
    serves is stripped, which is a quarter of its compressed size - the single
    biggest asset of a cold page load.

    Knowing when a '/' opens a regex and when a backtick closes a template is
    the whole difficulty: a template's ${...} holds arbitrary code that may
    contain another template. The state stack below tracks that, and anything
    inside a literal is copied verbatim, so only code-context whitespace and
    comments ever go. Verified by tokenising the bundle before and after with
    esprima and comparing the streams - identical, 58118 tokens - which is how
    two earlier attempts were caught silently reindenting HTML templates.
    """
    src = text
    out = []
    i, n = 0, len(src)
    prev = ''          # last significant code char: tells a regex from a division
    stack = []         # 'tpl' inside a template literal, 'expr' inside its ${...}

    while i < n:
        c = src[i]
        nx = src[i + 1] if i + 1 < n else ''

        if stack and stack[-1] == 'tpl':
            if c == _JS_BS:
                out.append(src[i:i + 2]); i += 2; continue
            if c == '`':
                out.append(c); i += 1; stack.pop(); prev = '`'; continue
            if c == '$' and nx == '{':
                out.append('${'); i += 2; stack.append('expr'); prev = '{'; continue
            out.append(c); i += 1
            continue

        if c == '/' and nx == '/':
            while i < n and src[i] not in '\r\n':
                i += 1
            continue
        if c == '/' and nx == '*':
            i += 2
            while i < n and not (src[i] == '*' and i + 1 < n and src[i + 1] == '/'):
                i += 1
            i += 2
            continue
        if c in ('"', "'"):
            q = c
            out.append(c); i += 1
            while i < n:
                if src[i] == _JS_BS:
                    out.append(src[i:i + 2]); i += 2; continue
                out.append(src[i])
                if src[i] == q:
                    i += 1; break
                i += 1
            prev = q
            continue
        if c == '`':
            out.append(c); i += 1; stack.append('tpl'); prev = '`'
            continue
        if c == '}' and stack and stack[-1] == 'expr':
            out.append(c); i += 1; stack.pop(); prev = '}'
            continue
        if c == '/' and (prev == '' or prev in '(,=:[!&|?{};+-*%~^<>'):
            out.append(c); i += 1
            inclass = False
            while i < n:
                if src[i] == _JS_BS:
                    out.append(src[i:i + 2]); i += 2; continue
                ch = src[i]
                if ch in '\r\n':
                    break
                out.append(ch); i += 1
                if ch == '[':
                    inclass = True
                elif ch == ']':
                    inclass = False
                elif ch == '/' and not inclass:
                    break
            prev = '/'
            continue

        if c.isspace():
            j, nl = i, False
            while j < n and src[j].isspace():
                if src[j] in '\r\n':
                    nl = True
                j += 1
            # A newline has to survive as one: automatic semicolon insertion
            # depends on it.
            if out:
                out.append('\n' if nl else ' ')
            i = j
            continue

        out.append(c)
        prev = c
        i += 1

    return ''.join(out)

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

def write_gz(data: bytes, gz_path: str):
    # Reproducible output: gzip.open() stamps the current time and the member
    # name into the header, so two builds of an identical source produced two
    # different .gz files (and therefore a different littlefs.bin).  mtime=0 and
    # an empty filename remove both.
    with open(gz_path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw,
                           compresslevel=9, mtime=0) as gz:
            gz.write(data)

def concat_js_chunks(src_dir: str, dst_dir: str):
    # The ordered chunks in data-dev/js/ become the single index.js.gz the
    # firmware serves; one gzip dictionary over the whole app also compresses
    # better than per-chunk files would.
    jsdir = os.path.join(src_dir, "js")
    if not os.path.isdir(jsdir):
        return
    parts = []
    total = 0
    for fname in sorted(os.listdir(jsdir)):
        if fname.startswith(".") or not fname.endswith(".js"):
            continue
        path = os.path.join(jsdir, fname)
        total += os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            parts.append(minify_js(f.read()))
    if not parts:
        return
    _ASSET_VER["js"] = _content_ver("\n".join(parts))
    gz_path = os.path.join(dst_dir, "index.js.gz")
    # Join with a newline: a chunk missing its trailing newline must not glue its
    # last line (possibly a // comment) onto the first line of the next chunk.
    write_gz("\n".join(parts).encode("utf-8"), gz_path)
    new_sz = os.path.getsize(gz_path)
    pct = ((total - new_sz) / total * 100) if total else 0
    print(f"  {'js/* -> index.js':<30} {total:>7} -> {new_sz:>7} B ({pct:>3.0f}%) [concat+minify+gzip]")

def concat_css_chunks(src_dir: str, dst_dir: str):
    # base/main/overlays become one app.css.gz: same payload, two fewer TCP
    # round-trips on the synchronous one-connection-at-a-time server.
    parts = []
    total = 0
    for name in CSS_CHUNKS:
        path = os.path.join(src_dir, name)
        if not os.path.isfile(path):
            return
        total += os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            parts.append(minify_css(f.read()))
    _ASSET_VER["css"] = _content_ver("\n".join(parts))
    gz_path = os.path.join(dst_dir, "app.css.gz")
    write_gz("\n".join(parts).encode("utf-8"), gz_path)
    new_sz = os.path.getsize(gz_path)
    pct = ((total - new_sz) / total * 100) if total else 0
    print(f"  {'*.css -> app.css':<30} {total:>7} -> {new_sz:>7} B ({pct:>3.0f}%) [concat+minify+gzip]")

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
        write_gz(content.encode("utf-8"), gz_path)

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

    concat_js_chunks(src_dir, dst_dir)
    concat_css_chunks(src_dir, dst_dir)
    for root, dirs, files in os.walk(src_dir):
        # The js/ chunks were already concatenated into index.js.gz above.
        if root == src_dir:
            dirs[:] = [d for d in dirs if d != "js"]
        for fname in sorted(files):
            if fname.startswith(".") or fname.endswith("~"): continue
            # The CSS chunks were already concatenated into app.css.gz above.
            if root == src_dir and fname in CSS_CHUNKS: continue

            src_path = os.path.join(root, fname)
            rel_path = os.path.relpath(src_path, src_dir)
            dst_path = os.path.join(dst_dir, rel_path)

            action, old_sz, new_sz = process_file(src_path, dst_path)

            saved = old_sz - new_sz
            pct = (saved / old_sz * 100) if old_sz > 0 else 0
            print(f"  {rel_path:<30} {old_sz:>7} -> {new_sz:>7} B ({pct:>3.0f}%) [{action}]")

# Lancement
minify_all()
