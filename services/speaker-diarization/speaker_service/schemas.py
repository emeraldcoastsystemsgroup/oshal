"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Defined the stable local diarization wire contract.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class DiarizedTurn(BaseModel):
    """One time-bounded anonymous speaker turn."""

    model_config = ConfigDict(extra="forbid")

    turnIndex: int = Field(ge=0)
    speakerKey: str = Field(pattern=r"^speaker-[1-9][0-9]*$")
    startTime: float = Field(ge=0)
    endTime: float = Field(gt=0)
    overlap: bool


class DiarizedSpeaker(BaseModel):
    """One chunk-local speaker and its normalized voice embedding."""

    model_config = ConfigDict(extra="forbid")

    speakerKey: str = Field(pattern=r"^speaker-[1-9][0-9]*$")
    embedding: list[float]
    voicedSeconds: float = Field(ge=0)


class DiarizationResponse(BaseModel):
    """Versioned output consumed by OSHAL's stable profile-clustering layer."""

    model_config = ConfigDict(extra="forbid")

    modelId: str
    sampleRate: int = Field(gt=0)
    durationSeconds: float = Field(ge=0)
    turns: list[DiarizedTurn]
    speakers: list[DiarizedSpeaker]


class TranscriptSegment(BaseModel):
    """One speaker turn with its decoded words."""

    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0)
    speakerKey: str = Field(pattern=r"^speaker-[1-9][0-9]*$")
    startTime: float = Field(ge=0)
    endTime: float = Field(gt=0)
    text: str


class TranscriptionResponse(BaseModel):
    """Speaker-labelled transcript produced entirely on this host."""

    model_config = ConfigDict(extra="forbid")

    modelId: str
    asrModelId: str
    sampleRate: int = Field(gt=0)
    durationSeconds: float = Field(ge=0)
    speakerCount: int = Field(ge=0)
    segments: list[TranscriptSegment]


class HealthResponse(BaseModel):
    """Readiness response that exposes no model path or host detail."""

    model_config = ConfigDict(extra="forbid")

    status: str
    ready: bool
    modelId: str
    sampleRate: int
