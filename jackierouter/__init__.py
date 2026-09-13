"""jackierouter — predictive, cost-tiered AI routing with context-preserving failover.

    from jackierouter import RouteRequest, router_from_env

    router = router_from_env()
    result = router.dispatch(RouteRequest(messages=[{"role": "user", "content": "hi"}]))
    print(result.text, result.provider, result.cost)

The core has no third-party dependencies. The FastAPI gateway in
``jackierouter.gateway`` is optional and only needed if you want the router
behind HTTP.
"""

from .adapters import EchoAdapter, OllamaAdapter, OpenAICompatAdapter
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
from .quota_ledger import Forecast, QuotaLedger
from .router import CONSERVE, MIGRATE, Router
from .types import (
    AdapterResult,
    Attempt,
    Limit,
    Provider,
    RouteRequest,
    RoutingResult,
    Usage,
)

__version__ = "0.1.0"

__all__ = [
    "AdapterResult",
    "Attempt",
    "BudgetExceeded",
    "BudgetGuardian",
    "CONSERVE",
    "EchoAdapter",
    "Forecast",
    "HandoffBriefing",
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
    "Usage",
    "build_briefing",
    "build_router",
    "load_config",
    "router_from_env",
    "__version__",
]
