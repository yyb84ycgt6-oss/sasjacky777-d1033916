"""jackierouter — predictive, cost-tiered AI routing with context-preserving failover.

    from jackierouter import RouteRequest, router_from_env

    router = router_from_env()
    result = router.dispatch(RouteRequest(messages=[{"role": "user", "content": "hi"}]))
    print(result.text, result.provider, result.cost)

It knows what machine it is on: providers can declare hardware requirements
(free VRAM, GPU temperature, whether the model is actually pulled) and are
skipped before the call when the box cannot serve them.

    python -m jackierouter detect     # what this machine is
    python -m jackierouter suggest    # a ladder built from what was detected

The core has no third-party dependencies. The FastAPI gateway in
``jackierouter.gateway`` is optional and only needed if you want the router
behind HTTP.
"""

from .adapters import EchoAdapter, OllamaAdapter, OpenAICompatAdapter
from .anthropic_adapter import AnthropicAdapter
from .budget_guardian import BudgetGuardian, SpendWindow
from .config import build_router, load_config, router_from_env
from .errors import (
    BudgetExceeded,
    NoProviderAvailable,
    ProviderError,
    RateLimited,
    RouterError,
)
from .handoff import HandoffBriefing, build_briefing
from .persistence import StateStore
from .quota_ledger import Forecast, QuotaLedger
from .router import CONSERVE, MIGRATE, Router, StreamingDispatch
from .system_profile import GPU, SystemProbe, SystemProfile, probe
from .types import (
    AdapterResult,
    Attempt,
    HardwareRequirements,
    Limit,
    Provider,
    RouteRequest,
    RoutingResult,
    StreamEvent,
    Usage,
)

__version__ = "0.2.0"

__all__ = [
    "AdapterResult",
    "AnthropicAdapter",
    "Attempt",
    "BudgetExceeded",
    "BudgetGuardian",
    "CONSERVE",
    "EchoAdapter",
    "Forecast",
    "GPU",
    "HandoffBriefing",
    "HardwareRequirements",
    "Limit",
    "MIGRATE",
    "NoProviderAvailable",
    "OllamaAdapter",
    "OpenAICompatAdapter",
    "Provider",
    "ProviderError",
    "QuotaLedger",
    "RateLimited",
    "RouteRequest",
    "Router",
    "RouterError",
    "RoutingResult",
    "SpendWindow",
    "StateStore",
    "StreamEvent",
    "StreamingDispatch",
    "SystemProbe",
    "SystemProfile",
    "Usage",
    "build_briefing",
    "build_router",
    "load_config",
    "probe",
    "router_from_env",
    "__version__",
]
