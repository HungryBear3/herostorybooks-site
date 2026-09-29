"""Validation issue and rejection types.

Issues carry only a code and a JSON path built from schema keys and array
indices. They never carry input values, so rendering an issue cannot leak the
data that caused it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional


@dataclass(frozen=True)
class Issue:
    code: str
    path: str = "$"

    def render(self) -> str:
        return f"{self.code} at {self.path}"


class InputRejected(Exception):
    """Raised when an input (or a set of inputs) fails closed."""

    def __init__(self, issues: Iterable[Issue], sha256: Optional[str] = None):
        self.issues = tuple(issues)
        self.sha256 = sha256
        super().__init__("; ".join(issue.render() for issue in self.issues))
