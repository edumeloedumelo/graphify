"""graphify jarvis — a conversational assistant over the knowledge graph.

`graphify jarvis` starts an interactive REPL. You type plain-language requests;
jarvis parses the intent and routes to the existing graph primitives so you can
explore a codebase by talking to it instead of memorizing subcommands:

    jarvis> what is APIRouter                 -> explain
    jarvis> how does FastAPI connect to ModelField  -> path
    jarvis> what depends on APIRouter         -> affected
    jarvis> where is request validation done  -> query (scoped subgraph)
    jarvis> overview                          -> graph stats + hubs
    jarvis> communities                       -> detected topics/modules
    jarvis> help / quit

It works fully offline: every answer is derived deterministically from
graph.json. When an LLM backend is configured (any of the keys `detect_backend`
looks for), jarvis also synthesizes a short natural-language answer grounded in
the retrieved subgraph — never from the model's own memory. Disable that with
`--no-llm` or `GRAPHIFY_JARVIS_NO_LLM=1`.

A single question can also be answered non-interactively:

    graphify jarvis "what is APIRouter"       # answer once, exit

The intent parser (`parse_intent`) is a pure function so it is unit-tested
without a graph or a terminal.
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path


# ── Intent parsing ────────────────────────────────────────────────────────────
# A jarvis line resolves to exactly one Intent. Parsing is keyword/pattern based
# and deterministic — no LLM — so routing is predictable and testable. The order
# of checks matters: more specific shapes (path, affected) are matched before the
# catch-all `query`, and single-word meta commands before free text.

_QUIT_WORDS = {"quit", "exit", "bye", "q", ":q", ":quit", "\\q"}
_HELP_WORDS = {"help", "?", "h", "commands", "\\h", "\\?"}
_OVERVIEW_WORDS = {"overview", "stats", "status", "summary", "info", "about"}
_COMMUNITY_WORDS = {
    "communities", "community", "topics", "modules", "clusters", "areas",
}

# "path from A to B" / "path A to B" / "connect(ion) A to B" / plain "A to B".
_PATH_PATTERNS = (
    re.compile(r"^\s*path\s+from\s+(?P<a>.+?)\s+to\s+(?P<b>.+?)\s*$", re.I),
    re.compile(r"^\s*path\s+(?P<a>.+?)\s+to\s+(?P<b>.+?)\s*$", re.I),
    re.compile(r"how\s+(?:does|do|is|are)\s+(?P<a>.+?)\s+(?:connect|connected|related|relate|link|linked)\s+(?:to|with)\s+(?P<b>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"how\s+(?:are|is|do|does)\s+(?P<a>.+?)\s+and\s+(?P<b>.+?)\s+(?:connect|connected|related|relate|link|linked)\s*[?.]?\s*$", re.I),
    re.compile(r"(?:connection|link|relationship|relation|path)\s+(?:between|from)\s+(?P<a>.+?)\s+(?:to|and|with)\s+(?P<b>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"^\s*(?P<a>.+?)\s+to\s+(?P<b>.+?)\s*$", re.I),
)

# "what depends on X" / "who calls X" / "impact of X" / "what breaks if X" ...
_AFFECTED_PATTERNS = (
    re.compile(r"what\s+(?:else\s+)?(?:depends?\s+on|uses|calls?|imports?|references?)\s+(?P<x>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"who\s+(?:depends?\s+on|uses|calls?|imports?|references?)\s+(?P<x>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:impact|blast\s*radius|fallout)\s+of\s+(?:changing\s+)?(?P<x>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"what\s+(?:breaks?|is\s+affected|would\s+break)\s+if\s+(?:i\s+)?(?:change|touch|remove|delete|modify)\s+(?P<x>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"(?:callers?|dependents?|users?)\s+of\s+(?P<x>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"^\s*(?:affected|impact|dependents?|callers?)\s+(?P<x>.+?)\s*[?.]?\s*$", re.I),
)

# "explain X" / "what is X" / "tell me about X" / "describe X" / "define X" ...
_EXPLAIN_PATTERNS = (
    re.compile(r"^\s*(?:explain|describe|define)\s+(?P<x>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"^\s*what(?:'s| is| are| was)\s+(?:a\s+|an\s+|the\s+)?(?P<x>.+?)\s*[?.]?\s*$", re.I),
    re.compile(r"^\s*(?:tell\s+me\s+about|show\s+me|what\s+about)\s+(?P<x>.+?)\s*[?.]?\s*$", re.I),
)


@dataclass
class Intent:
    """A parsed jarvis request. ``kind`` selects the handler; the remaining
    fields carry the extracted arguments for that handler."""

    kind: str            # help | quit | overview | communities | explain | path | affected | query | noop
    target: str = ""     # explain/affected subject, or the raw query text
    source: str = ""     # path source endpoint
    dest: str = ""       # path target endpoint


def _clean(text: str) -> str:
    return text.strip().strip("\"'").strip()


def parse_intent(text: str) -> Intent:
    """Classify a line of user input into a routable :class:`Intent`.

    Pure and side-effect free — no graph access, no I/O — so the routing rules
    can be exercised directly in tests.
    """
    raw = text.strip()
    if not raw:
        return Intent("noop")

    low = raw.strip().lower()
    low_np = low.rstrip("?.! ")  # trailing punctuation stripped
    words = low_np.split()

    # Single-token meta commands. Check both forms so a bare "?" (which strips to
    # empty) and a punctuated "overview?" both resolve.
    if low in _QUIT_WORDS or low_np in _QUIT_WORDS:
        return Intent("quit")
    if low in _HELP_WORDS or low_np in _HELP_WORDS:
        return Intent("help")
    if low_np in _OVERVIEW_WORDS or (len(words) <= 2 and words and words[0] in _OVERVIEW_WORDS):
        return Intent("overview")
    if low_np in _COMMUNITY_WORDS or (
        len(words) <= 3 and words and words[0] in ("list", "show") and any(w in _COMMUNITY_WORDS for w in words)
    ):
        return Intent("communities")

    # Explicit-verb intents win over the generic shapes, so "explain X to Y" is
    # an explanation of "X to Y", not a path. Path/affected are matched before
    # the bare "A to B" fallback and before the general query catch-all.
    for pat in _EXPLAIN_PATTERNS:
        m = pat.match(raw)
        if m:
            subj = _clean(m.group("x"))
            if subj:
                return Intent("explain", target=subj)

    for pat in _AFFECTED_PATTERNS:
        m = pat.search(raw)
        if m:
            subj = _clean(m.group("x"))
            if subj:
                return Intent("affected", target=subj)

    for pat in _PATH_PATTERNS:
        m = pat.search(raw)
        if m:
            a, b = _clean(m.group("a")), _clean(m.group("b"))
            # The bare "A to B" fallback is greedy; reject degenerate empties.
            if a and b:
                return Intent("path", source=a, dest=b)

    # Everything else is a free-form question → scoped subgraph query.
    return Intent("query", target=raw)


# ── Graph handlers ────────────────────────────────────────────────────────────
# Each returns a plain string. They reuse the same primitives the `explain`,
# `path`, `affected`, and `query` subcommands use, so answers are identical to
# running those commands directly.


def _explain(G, label: str, graph_path: Path) -> str:
    from graphify.serve import _find_node
    from graphify.build import edge_data

    matches = _find_node(G, label)
    if not matches:
        return f"I couldn't find anything matching '{label}' in the graph."
    nid = matches[0]
    d = G.nodes[nid]
    lines = [
        f"Node: {d.get('label', nid)}",
        f"  Source:    {d.get('source_file', '')} {d.get('source_location', '')}".rstrip(),
        f"  Community: {d.get('community_name') or d.get('community', '')}",
        f"  Degree:    {G.degree(nid)}",
    ]
    connections: list[tuple[str, str, dict]] = []
    for nb in G.successors(nid):
        connections.append(("out", nb, edge_data(G, nid, nb)))
    for nb in G.predecessors(nid):
        connections.append(("in", nb, edge_data(G, nb, nid)))
    if connections:
        connections.sort(key=lambda c: G.degree(c[1]), reverse=True)
        lines.append(f"\nConnections ({len(connections)}):")
        for direction, nb, edata in connections[:20]:
            arrow = "-->" if direction == "out" else "<--"
            rel = edata.get("relation", "")
            conf = edata.get("confidence", "")
            lines.append(f"  {arrow} {G.nodes[nb].get('label', nb)} [{rel}] [{conf}]")
        if len(connections) > 20:
            lines.append(f"  ... and {len(connections) - 20} more")
    return "\n".join(lines)


def _path(G, source_label: str, target_label: str) -> str:
    import networkx as nx
    from graphify.serve import _pick_scored_endpoint, _score_nodes
    from graphify.build import edge_data

    src_scored = _score_nodes(G, [t.lower() for t in source_label.split()])
    tgt_scored = _score_nodes(G, [t.lower() for t in target_label.split()])
    if not src_scored:
        return f"No node matching '{source_label}' found."
    if not tgt_scored:
        return f"No node matching '{target_label}' found."
    src_nid = _pick_scored_endpoint(G, src_scored, source_label)
    tgt_nid = _pick_scored_endpoint(G, tgt_scored, target_label)
    if src_nid == tgt_nid:
        return (
            f"'{source_label}' and '{target_label}' both resolved to the same node "
            f"'{src_nid}'. Try a more specific name."
        )
    try:
        path_nodes = nx.shortest_path(G.to_undirected(as_view=True), src_nid, tgt_nid)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return f"No path found between '{source_label}' and '{target_label}'."
    hops = len(path_nodes) - 1
    segments = []
    for i in range(len(path_nodes) - 1):
        u, v = path_nodes[i], path_nodes[i + 1]
        if G.has_edge(u, v):
            edata = edge_data(G, u, v)
            forward = True
        else:
            edata = edge_data(G, v, u)
            forward = False
        rel = edata.get("relation", "")
        conf = edata.get("confidence", "")
        conf_str = f" [{conf}]" if conf else ""
        if i == 0:
            segments.append(G.nodes[u].get("label", u))
        if forward:
            segments.append(f"--{rel}{conf_str}--> {G.nodes[v].get('label', v)}")
        else:
            segments.append(f"<--{rel}{conf_str}-- {G.nodes[v].get('label', v)}")
    return f"Shortest path ({hops} hops):\n  " + " ".join(segments)


def _affected(graph_path: Path, query: str) -> str:
    from graphify.affected import DEFAULT_AFFECTED_RELATIONS, format_affected, load_graph

    graph = load_graph(graph_path)
    return format_affected(graph, query, relations=DEFAULT_AFFECTED_RELATIONS, depth=2)


def _query(G, question: str, budget: int = 2000) -> str:
    from graphify.serve import _query_graph_text

    return _query_graph_text(G, question, mode="bfs", depth=2, token_budget=budget)


def _overview(G, graph_path: Path) -> str:
    n = G.number_of_nodes()
    e = G.number_of_edges()
    communities = {
        (G.nodes[nid].get("community_name") or G.nodes[nid].get("community"))
        for nid in G.nodes
    }
    communities.discard(None)
    communities.discard("")
    hubs = sorted(G.nodes, key=lambda nid: G.degree(nid), reverse=True)[:8]
    lines = [
        f"Knowledge graph: {n} nodes, {e} edges, {len(communities)} communities.",
        f"Source: {graph_path}",
        "",
        "Most connected nodes (likely entry points):",
    ]
    for nid in hubs:
        d = G.nodes[nid]
        loc = f"{d.get('source_file', '')} {d.get('source_location', '')}".strip()
        lines.append(f"  - {d.get('label', nid)}  (degree {G.degree(nid)})  {loc}".rstrip())
    lines.append("")
    lines.append('Ask me things like "what is <X>", "what depends on <X>", '
                 '"how does <A> connect to <B>", or any question about the code.')
    return "\n".join(lines)


def _communities(G) -> str:
    counts: dict[str, int] = {}
    for nid in G.nodes:
        name = G.nodes[nid].get("community_name") or G.nodes[nid].get("community")
        if name in (None, ""):
            continue
        key = str(name)
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return "No communities were detected in this graph."
    ordered = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    lines = [f"{len(ordered)} communities (topics/modules), by size:"]
    for name, size in ordered[:25]:
        lines.append(f"  - {name}  ({size} nodes)")
    if len(ordered) > 25:
        lines.append(f"  ... and {len(ordered) - 25} more")
    return "\n".join(lines)


# ── LLM synthesis (optional, grounded) ────────────────────────────────────────

_JARVIS_SYSTEM = (
    "You are Jarvis, a concise coding assistant answering questions about a "
    "specific codebase. Answer ONLY from the knowledge-graph context provided "
    "below — do not use outside knowledge or invent files, symbols, or "
    "relationships. If the context does not contain the answer, say so plainly. "
    "Prefer 2-5 sentences and cite node or file names from the context.\n\n"
    "User question:\n{question}\n\n"
    "Knowledge-graph context:\n{context}\n"
)


def _synthesize(question: str, context: str, backend: str, model: str | None) -> str | None:
    """Turn a retrieved subgraph into a short natural-language answer.

    Returns None on any failure so the caller can fall back to the raw subgraph
    text — the LLM layer is a convenience, never a hard dependency.
    """
    from graphify.llm import _call_llm

    prompt = _JARVIS_SYSTEM.format(question=question, context=context[:12000])
    try:
        reply = _call_llm(prompt, backend=backend, model=model, max_tokens=500)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully to raw context
        print(f"[jarvis] LLM synthesis unavailable ({exc}); showing raw graph result.",
              file=sys.stderr)
        return None
    reply = (reply or "").strip()
    return reply or None


# ── Session ───────────────────────────────────────────────────────────────────

_BANNER = (
    "graphify jarvis — talk to your knowledge graph. Type 'help' for examples, "
    "'quit' to exit."
)

_HELP = """\
Jarvis understands plain language and routes it to the graph:

  what is <X>                     explain a node and its connections
  tell me about <X> / describe <X>
  what depends on <X>             reverse impact (callers/importers/users)
  who calls <X> / impact of <X>
  how does <A> connect to <B>     shortest path between two nodes
  path from <A> to <B>
  <any question>                  scoped subgraph for the question
  overview / stats                graph size + most-connected nodes
  communities                     detected topics/modules
  help                            this message
  quit / exit                     leave

Answers come straight from graph.json. With an LLM backend configured, Jarvis
also writes a short grounded summary; disable with --no-llm.\
"""


class Jarvis:
    """Holds the loaded graph and answers parsed intents.

    A directed graph (``self.G``) backs explain/path/overview/communities so the
    stored caller→callee direction survives; ``self.qG`` respects the graph's own
    directed flag for query traversal, matching the standalone `graphify query`.
    """

    def __init__(self, graph_path: Path, *, use_llm: bool = True,
                 backend: str | None = None, model: str | None = None) -> None:
        self.graph_path = graph_path
        self._raw = self._load_raw(graph_path)
        self.G = self._build_directed()
        self.qG = self._build_query_graph()
        self.model = model
        self.backend = None
        if use_llm:
            from graphify.llm import detect_backend
            try:
                self.backend = backend or detect_backend()
            except Exception:
                self.backend = None

    @staticmethod
    def _load_raw(graph_path: Path) -> dict:
        import json
        from graphify.security import check_graph_file_size_cap

        check_graph_file_size_cap(graph_path)
        raw = json.loads(graph_path.read_text(encoding="utf-8"))
        if "links" not in raw and "edges" in raw:
            raw = dict(raw, links=raw["edges"])
        return raw

    def _build_directed(self):
        from networkx.readwrite import json_graph

        raw = {**self._raw, "directed": True}
        try:
            return json_graph.node_link_graph(raw, edges="links")
        except TypeError:
            return json_graph.node_link_graph(raw)

    def _build_query_graph(self):
        from networkx.readwrite import json_graph

        try:
            return json_graph.node_link_graph(self._raw, edges="links")
        except TypeError:
            return json_graph.node_link_graph(self._raw)

    def answer(self, text: str) -> str:
        """Parse ``text`` and return the answer string (no I/O)."""
        intent = parse_intent(text)
        if intent.kind == "noop":
            return ""
        if intent.kind == "help":
            return _HELP
        if intent.kind == "overview":
            return _overview(self.G, self.graph_path)
        if intent.kind == "communities":
            return _communities(self.G)
        if intent.kind == "explain":
            return _explain(self.G, intent.target, self.graph_path)
        if intent.kind == "path":
            return _path(self.G, intent.source, intent.dest)
        if intent.kind == "affected":
            return _affected(self.graph_path, intent.target)
        # query — retrieve subgraph, optionally synthesize a grounded answer.
        context = _query(self.qG, intent.target)
        if self.backend:
            summary = _synthesize(intent.target, context, self.backend, self.model)
            if summary:
                return f"{summary}\n\n---\nGraph context:\n{context}"
        return context


def _resolve_graph_path(explicit: str | None) -> Path:
    from graphify.paths import GRAPHIFY_OUT

    if explicit:
        return Path(explicit).resolve()
    return (Path(GRAPHIFY_OUT) / "graph.json").resolve()


def run(argv: list[str]) -> int:
    """Entry point for ``graphify jarvis`` (argv is everything after the command).

    With a trailing free-text question, answers once and exits; otherwise starts
    the interactive REPL. Returns a process exit code.
    """
    graph_arg: str | None = None
    use_llm = not _env_flag("GRAPHIFY_JARVIS_NO_LLM")
    backend: str | None = None
    model: str | None = None
    question_parts: list[str] = []

    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--graph" and i + 1 < len(argv):
            graph_arg = argv[i + 1]; i += 2
        elif a.startswith("--graph="):
            graph_arg = a.split("=", 1)[1]; i += 1
        elif a == "--no-llm":
            use_llm = False; i += 1
        elif a == "--backend" and i + 1 < len(argv):
            backend = argv[i + 1]; i += 2
        elif a.startswith("--backend="):
            backend = a.split("=", 1)[1]; i += 1
        elif a == "--model" and i + 1 < len(argv):
            model = argv[i + 1]; i += 2
        elif a.startswith("--model="):
            model = a.split("=", 1)[1]; i += 1
        else:
            question_parts.append(a); i += 1

    graph_path = _resolve_graph_path(graph_arg)
    if not graph_path.exists():
        print(f"error: graph file not found: {graph_path}\n"
              f"Run /graphify (or `graphify extract .`) first to build the graph.",
              file=sys.stderr)
        return 1
    if graph_path.suffix != ".json":
        print("error: graph file must be a .json file", file=sys.stderr)
        return 1

    try:
        jarvis = Jarvis(graph_path, use_llm=use_llm, backend=backend, model=model)
    except ValueError as exc:  # size cap
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"error: could not load graph: {exc}", file=sys.stderr)
        return 1

    question = " ".join(question_parts).strip()
    if question:
        out = jarvis.answer(question)
        if out:
            print(out)
        return 0

    return _repl(jarvis)


def _repl(jarvis: Jarvis) -> int:
    interactive = sys.stdin is not None and sys.stdin.isatty()
    if interactive:
        print(_BANNER)
        n = jarvis.G.number_of_nodes()
        e = jarvis.G.number_of_edges()
        backend = jarvis.backend or "none (offline, deterministic answers)"
        print(f"Loaded {n} nodes / {e} edges from {jarvis.graph_path}. LLM backend: {backend}.\n")
    while True:
        try:
            line = input("jarvis> " if interactive else "")
        except (EOFError, KeyboardInterrupt):
            if interactive:
                print()
            break
        intent = parse_intent(line)
        if intent.kind == "quit":
            if interactive:
                print("Bye.")
            break
        if intent.kind == "noop":
            continue
        try:
            out = jarvis.answer(line)
        except Exception as exc:  # noqa: BLE001 - one bad line shouldn't kill the REPL
            print(f"[jarvis] error: {exc}", file=sys.stderr)
            continue
        if out:
            print(out)
            if interactive:
                print()
    return 0


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")
