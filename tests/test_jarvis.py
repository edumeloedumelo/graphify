from __future__ import annotations

import json

import networkx as nx
import pytest
from networkx.readwrite import json_graph

import graphify.__main__ as mainmod
from graphify.jarvis import Jarvis, parse_intent


# ── Intent parsing (pure) ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,kind",
    [
        ("", "noop"),
        ("   ", "noop"),
        ("quit", "quit"),
        ("exit", "quit"),
        (":q", "quit"),
        ("help", "help"),
        ("?", "help"),
        ("overview", "overview"),
        ("stats", "overview"),
        ("communities", "communities"),
        ("topics", "communities"),
    ],
)
def test_parse_intent_meta_commands(text, kind):
    assert parse_intent(text).kind == kind


@pytest.mark.parametrize(
    "text,target",
    [
        ("explain APIRouter", "APIRouter"),
        ("describe FastAPI", "FastAPI"),
        ("what is APIRouter", "APIRouter"),
        ("what's the Dependant class", "Dependant class"),
        ("tell me about routing.py", "routing.py"),
        ("show me get_request_handler", "get_request_handler"),
    ],
)
def test_parse_intent_explain(text, target):
    intent = parse_intent(text)
    assert intent.kind == "explain"
    assert intent.target == target


@pytest.mark.parametrize(
    "text,target",
    [
        ("what depends on APIRouter", "APIRouter"),
        ("who calls get_request_handler", "get_request_handler"),
        ("what uses ModelField", "ModelField"),
        ("impact of changing APIRouter", "APIRouter"),
        ("what breaks if I change APIRouter", "APIRouter"),
        ("callers of APIRouter", "APIRouter"),
        ("dependents of ModelField", "ModelField"),
    ],
)
def test_parse_intent_affected(text, target):
    intent = parse_intent(text)
    assert intent.kind == "affected"
    assert intent.target == target


@pytest.mark.parametrize(
    "text,source,dest",
    [
        ("path from FastAPI to ModelField", "FastAPI", "ModelField"),
        ("path FastAPI to ModelField", "FastAPI", "ModelField"),
        ("how does FastAPI connect to ModelField", "FastAPI", "ModelField"),
        ("how are FastAPI and ModelField related", "FastAPI", "ModelField"),
        ("connection between FastAPI and ModelField", "FastAPI", "ModelField"),
        ("FastAPI to ModelField", "FastAPI", "ModelField"),
    ],
)
def test_parse_intent_path(text, source, dest):
    intent = parse_intent(text)
    assert intent.kind == "path"
    assert intent.source == source
    assert intent.dest == dest


@pytest.mark.parametrize(
    "text",
    [
        "where is request validation performed",
        "how does authentication work",
        "summarize the export pipeline",
    ],
)
def test_parse_intent_query_fallback(text):
    intent = parse_intent(text)
    assert intent.kind == "query"
    assert intent.target == text


def test_explain_verb_beats_path_shape():
    # "explain X to Y" is an explanation of "X to Y", not a path query.
    intent = parse_intent("explain converting A to B")
    assert intent.kind == "explain"
    assert intent.target == "converting A to B"


# ── Graph-backed handlers ─────────────────────────────────────────────────────


def _write_graph(tmp_path):
    graph = nx.DiGraph()
    graph.add_node("html.py", label="html.py", source_file="html.py", source_location="L1",
                   community=0, community_name="Rendering")
    graph.add_node("to_html", label="to_html()", source_file="html.py", source_location="L312",
                   community=0, community_name="Rendering")
    graph.add_node("styles", label="_html_styles()", source_file="html.py", source_location="L30",
                   community=0, community_name="Rendering")
    graph.add_node("graphdb.py", label="graphdb.py", source_file="graphdb.py", source_location="L1",
                   community=1, community_name="Persistence")
    graph.add_edge("html.py", "to_html", relation="contains", confidence="EXTRACTED")
    graph.add_edge("to_html", "styles", relation="calls", confidence="EXTRACTED")
    graph_path = tmp_path / "graph.json"
    graph_path.write_text(json.dumps(json_graph.node_link_data(graph, edges="links")),
                          encoding="utf-8")
    return graph_path


def test_answer_explain(tmp_path):
    j = Jarvis(_write_graph(tmp_path), use_llm=False)
    out = j.answer("what is to_html")
    assert "Node: to_html()" in out
    assert "html.py L312" in out
    assert "_html_styles()" in out  # connection listed


def test_answer_affected(tmp_path):
    j = Jarvis(_write_graph(tmp_path), use_llm=False)
    out = j.answer("what calls _html_styles")
    assert "Affected nodes for _html_styles()" in out
    assert "to_html()" in out


def test_answer_path(tmp_path):
    j = Jarvis(_write_graph(tmp_path), use_llm=False)
    out = j.answer("how does html.py connect to _html_styles")
    assert "Shortest path" in out
    assert "to_html()" in out


def test_answer_overview_and_communities(tmp_path):
    j = Jarvis(_write_graph(tmp_path), use_llm=False)
    overview = j.answer("overview")
    assert "4 nodes" in overview
    assert "2 communities" in overview
    assert "to_html()" in overview  # a hub
    communities = j.answer("communities")
    assert "Rendering" in communities
    assert "Persistence" in communities


def test_answer_query_returns_subgraph(tmp_path):
    j = Jarvis(_write_graph(tmp_path), use_llm=False)
    out = j.answer("how is html rendered")
    assert "Traversal:" in out
    assert "html.py" in out


def test_no_llm_skips_synthesis(tmp_path, monkeypatch):
    j = Jarvis(_write_graph(tmp_path), use_llm=False)
    assert j.backend is None

    def _boom(*a, **k):  # pragma: no cover - must never be called
        raise AssertionError("LLM must not be called when use_llm=False")

    monkeypatch.setattr("graphify.jarvis._synthesize", _boom)
    out = j.answer("how is html rendered")
    assert "Traversal:" in out


# ── CLI wiring ────────────────────────────────────────────────────────────────


def test_cli_jarvis_one_shot(monkeypatch, tmp_path, capsys):
    graph_path = _write_graph(tmp_path)
    monkeypatch.setattr(mainmod, "_check_skill_version", lambda _: None)
    monkeypatch.setenv("GRAPHIFY_JARVIS_NO_LLM", "1")
    monkeypatch.setattr(
        mainmod.sys,
        "argv",
        ["graphify", "jarvis", "--graph", str(graph_path), "what is to_html"],
    )
    with pytest.raises(SystemExit) as exc:
        mainmod.main()
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "Node: to_html()" in out


def test_cli_jarvis_missing_graph(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(mainmod, "_check_skill_version", lambda _: None)
    missing = tmp_path / "graph.json"
    monkeypatch.setattr(
        mainmod.sys,
        "argv",
        ["graphify", "jarvis", "--graph", str(missing), "overview"],
    )
    with pytest.raises(SystemExit) as exc:
        mainmod.main()
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "graph file not found" in err
