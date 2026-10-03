from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RunCreate(StrictModel):
    goal: str = Field(min_length=1, max_length=16000)
    workspace: str = Field(min_length=1, max_length=4096)
    profile: str = "review"
    principal: str = Field(default="local-user", min_length=1, max_length=256)
    session_id: str | None = None


class Action(StrictModel):
    tool: str = Field(min_length=1, max_length=256)
    arguments: dict[str, Any] = Field(default_factory=dict)


class Evaluate(StrictModel):
    schema_version: Literal[1] = 1
    run_id: str
    session_id: str = Field(min_length=1, max_length=256)
    call_id: str = Field(min_length=1, max_length=256)
    action: Action


class Decision(StrictModel):
    decision_id: str
    decision: Literal["ALLOW", "BLOCK", "REQUIRE_APPROVAL"]
    action_hash: str
    policy_version: str
    reason_codes: list[str]
    findings: list[str] = Field(default_factory=list)
    sensitive_run: bool
    approval_id: str | None = None
    permit: str | None = None


class ToolResult(StrictModel):
    run_id: str
    session_id: str
    call_id: str
    permit: str
    status: Literal["completed", "error"]
    result: Any = None


class Approval(StrictModel):
    approve: bool


class ContentEvent(StrictModel):
    run_id: str
    session_id: str
    event_id: str = Field(min_length=1, max_length=256)
    source: Literal["user", "tool", "repository"]
    text: str = Field(max_length=65536)

