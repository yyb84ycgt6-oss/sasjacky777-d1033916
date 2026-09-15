"""
The Jackie OS agent runtime — registry, pods, and the execution graph.

These modules were written on a branch and never merged, and the state they
arrived in says plainly that nothing had ever imported them: a constructor
calling a method the class did not define, three missing `typing` and
`dataclasses` names that are NameErrors at import, a return type using 3.10
union syntax against a 3.9 floor, and a set of flat imports that only resolved
if `fs/` itself happened to be on `sys.path`.

Each of those is now fixed, and each has a test here, because "recovered" and
"works" are different claims and only one of them is worth making.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Jackie.core.engine.fs.agent_registry import AgentConfig, AgentRegistry
from Jackie.core.engine.fs.execution_graph import ExecutionGraph, TaskNode, _failure_in
from Jackie.core.engine.fs.jackie_orchestrator import FSTaskResult
from Jackie.core.engine.fs.pod_backpack_manager import PodBackpackManager
from Jackie.core.engine.fs.tracing import TaskTrace


class FakeOrchestrator:
    """Stands in for the router-backed orchestrator. Records what it was asked."""

    def __init__(self, failures=None):
        self.calls = []
        self.failures = failures or {}

    def run_task(self, agent, content):
        self.calls.append((agent, content))
        if agent in self.failures:
            return {"error": self.failures[agent]}
        return {"agent": agent, "router_result": {"ok": True, "content": f"did {content}"}}


class TestTheRegistry:
    def test_it_registers_its_default_agents(self):
        registry = AgentRegistry()
        assert {"Jackie", "Analysis", "Code", "Memory"} <= set(registry.agents)

    def test_an_agent_carries_its_pod_and_backpack(self):
        agent = AgentRegistry().get("Code")
        assert agent.pod == "code"
        assert agent.backpack == "python"

    def test_registering_over_a_name_replaces_it(self):
        registry = AgentRegistry()
        registry.register(AgentConfig(name="Code", role="r", pod="p", backpack="b"))
        assert registry.get("Code").pod == "p"

    def test_an_unknown_agent_is_none_rather_than_a_raise(self):
        assert AgentRegistry().get("Nobody") is None


class TestPodsAndBackpacks:
    def test_constructing_it_works_at_all(self):
        """
        `__init__` called `_register_defaults`, which the class did not define —
        it defines `_register_pods` and `_register_backpacks`. Every attempt to
        build one raised AttributeError, so nothing in the runtime above it
        could ever have started.
        """
        manager = PodBackpackManager()
        assert manager.pods
        assert manager.backpacks

    def test_the_defaults_cover_the_agents_that_reference_them(self):
        manager = PodBackpackManager()
        for agent in AgentRegistry().agents.values():
            assert agent.pod in manager.pods, f"{agent.name} names a pod that does not exist"
            assert agent.backpack in manager.backpacks, f"{agent.name} names a missing backpack"

    def test_a_backpack_resolves_to_its_memory_partition(self):
        assert PodBackpackManager().resolve_memory_partition("reasoning") == "analysis-01"

    def test_an_unknown_backpack_resolves_to_nothing(self):
        assert PodBackpackManager().resolve_memory_partition("no-such-bag") is None


class TestTheExecutionGraph:
    def test_it_runs_a_task_with_no_dependencies(self):
        graph = ExecutionGraph(FakeOrchestrator())
        graph.add_task(TaskNode(id="solo", agent="Code", content="build it"))
        results = graph.run()
        assert results["solo"].success is True

    def test_a_dependent_task_runs_after_what_it_depends_on(self):
        orchestrator = FakeOrchestrator()
        graph = ExecutionGraph(orchestrator)
        graph.add_task(TaskNode(id="code", agent="Code", content="implement", depends_on=["plan"]))
        graph.add_task(TaskNode(id="plan", agent="Analysis", content="plan"))
        graph.run()
        assert [agent for agent, _ in orchestrator.calls] == ["Analysis", "Code"]

    def test_a_cycle_is_a_deadlock_rather_than_a_hang(self):
        graph = ExecutionGraph(FakeOrchestrator())
        graph.add_task(TaskNode(id="a", agent="Code", content="a", depends_on=["b"]))
        graph.add_task(TaskNode(id="b", agent="Code", content="b", depends_on=["a"]))
        with pytest.raises(RuntimeError, match="Deadlock"):
            graph.run()

    def test_a_failed_task_is_recorded_as_failed(self):
        """
        `run()` hardcoded `success=True` with a comment saying real code would
        check `router_result["error"]`. Nothing ever did, so a task whose agent
        did not exist was recorded as completed and its dependents ran against
        a result that was never produced.
        """
        graph = ExecutionGraph(FakeOrchestrator(failures={"Ghost": "Unknown agent: Ghost"}))
        graph.add_task(TaskNode(id="bad", agent="Ghost", content="go"))
        results = graph.run()
        assert results["bad"].success is False
        assert "Unknown agent" in results["bad"].message

    def test_a_failure_reported_by_the_router_counts_too(self):
        assert _failure_in({"router_result": {"error": "model not pulled"}}) == "model not pulled"
        assert _failure_in({"router_result": {"ok": True}}) is None
        assert _failure_in("not a dict at all") is None

    def test_get_task_is_callable_on_the_declared_python_floor(self):
        """The annotation was `TaskNode | None`, which is a TypeError on 3.9."""
        graph = ExecutionGraph(FakeOrchestrator())
        graph.add_task(TaskNode(id="x", agent="Code", content="c"))
        assert graph.get_task("x").agent == "Code"
        assert graph.get_task("absent") is None


class TestTracing:
    def test_two_traces_do_not_share_one_details_dict(self):
        """`details: Dict[str, Any] = None` gave every instance the same None."""
        first = TaskTrace(task_id="a", start_time=0.0)
        second = TaskTrace(task_id="b", start_time=0.0)
        first.details["only"] = "first"
        assert second.details == {}

    def test_completing_a_trace_records_the_outcome(self):
        trace = TaskTrace(task_id="a", start_time=0.0)
        trace.on_complete(False)
        assert trace.status == "error"


def test_the_result_type_the_graph_returns_is_the_orchestrator_s_own():
    """
    `execution_graph` returned `FSTaskResult` without importing it — a NameError
    the moment `run()` was called. It is defined in `jackie_orchestrator`.
    """
    graph = ExecutionGraph(FakeOrchestrator())
    graph.add_task(TaskNode(id="x", agent="Code", content="c"))
    assert isinstance(graph.run()["x"], FSTaskResult)
