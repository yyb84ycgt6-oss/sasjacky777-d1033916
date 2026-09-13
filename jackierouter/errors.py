"""Exception hierarchy for the router.

Adapters raise these; the orchestrator interprets them. Anything an adapter
raises that is *not* a RouterError is wrapped in ProviderError, so a badly
behaved adapter can never take the whole dispatch down.
"""


class RouterError(Exception):
    """Base class for every error the router raises or interprets."""


class ProviderError(RouterError):
    """A provider failed in a way that makes it a bad bet for a short while."""

    def __init__(self, message: str, *, provider: str = "", retry_after: float = 30.0):
        super().__init__(message)
        self.provider = provider
        self.retry_after = retry_after


class RateLimited(ProviderError):
    """A provider refused because its quota is spent.

    ``retry_after`` is the provider's own advice in seconds when it gives one
    (an HTTP ``Retry-After`` header), otherwise a conservative default.
    """

    def __init__(self, message: str, *, provider: str = "", retry_after: float = 60.0):
        super().__init__(message, provider=provider, retry_after=retry_after)


class NoProviderAvailable(RouterError):
    """Every candidate was filtered out, exhausted, or failed.

    ``trace`` carries the per-attempt decision log so the caller can see why.
    """

    def __init__(self, message: str, *, trace=None):
        super().__init__(message)
        self.trace = list(trace or [])


class BudgetExceeded(NoProviderAvailable):
    """Nothing was tried because every remaining option costs money you capped.

    A subclass of :class:`NoProviderAvailable` so callers that only care about
    "nothing served this" keep working, while callers that want to tell a
    spending stop from an outage can catch this specifically.
    """

