"""Async parse tasks (W1-B, docs/rag-pipeline-design.md §4.3).

The Node side orchestrates batches: it submits one async task per 20-page
slice and polls /tasks/parse-status. This module keeps an in-process registry
of asyncio tasks — deliberately NOT durable: the Node side owns document
state (attemptId in parseMeta); a lost task simply leaves the document in
parsing until the Node-side timeout marks it failed and a retry resubmits.

Cooperative cancellation: the cancel endpoint sets a flag checked between
batches, so a cancelled task wastes at most one in-flight docling conversion
(not an unbounded run). Hard termination (subprocess kill) is deliberately
NOT implemented — batch-granularity cooperative cancel plus the container
mem_limit bound worst-case waste to a single batch; this is a documented
trade-off (rag-pipeline §4.3: 协作取消优先).
"""

import asyncio
import time
from typing import Dict, List, Optional, Tuple

from . import parsing
from .schemas import ParseAsyncRequest, ParseBlock, ParseEvent, ParseTaskSnapshot


class _Task:
    def __init__(self, task_id: str):
        self.task_id = task_id
        self.status = "pending"
        self.stage: Optional[str] = None
        self.page_no: Optional[int] = None
        self.total_pages: Optional[int] = None
        self.error: Optional[str] = None
        self.events: List[ParseEvent] = []
        self.blocks: Optional[List[ParseBlock]] = None
        self.page_count: Optional[int] = None
        self.cancel_requested = False
        self.seq = 0
        self.created_at = time.time()

    def emit(self, stage: str, message: Optional[str] = None, duration_ms: Optional[int] = None) -> None:
        self.seq += 1
        self.stage = stage
        self.events.append(
            ParseEvent(seq=self.seq, stage=stage, message=message, atMs=int(time.time() * 1000), durationMs=duration_ms)
        )
        # Keep the event log bounded; Node persists it into parseMeta (truncated there too)
        if len(self.events) > 200:
            self.events = self.events[-100:]

    def snapshot(self, include_blocks: bool) -> ParseTaskSnapshot:
        return ParseTaskSnapshot(
            taskId=self.task_id,
            status=self.status,
            stage=self.stage,
            pageNo=self.page_no,
            totalPages=self.total_pages,
            error=self.error,
            events=list(self.events),
            blocks=self.blocks if include_blocks else None,
            pageCount=self.page_count,
        )


_registry: Dict[str, _Task] = {}
_MAX_REGISTRY = 50


def _prune() -> None:
    """Drop oldest finished tasks beyond the registry cap."""
    finished = [t for t in _registry.values() if t.status in ("completed", "failed", "cancelled")]
    finished.sort(key=lambda t: t.created_at)
    while len(_registry) > _MAX_REGISTRY and finished:
        _registry.pop(finished.pop(0).task_id)


def submit_parse(req: ParseAsyncRequest) -> ParseTaskSnapshot:
    task = _Task(req.taskId)
    _registry[req.taskId] = task
    _prune()

    async def run() -> None:
        task.status = "running"
        task.emit("enqueued", f"batch pages {req.pageFrom or 1}-{req.pageTo or 'end'}")
        try:
            import base64
            import binascii

            try:
                data = base64.b64decode(req.contentBase64, validate=True)
            except (binascii.Error, ValueError) as e:
                raise ValueError(f"invalid base64 payload: {e}")

            page_range: Optional[Tuple[int, int]] = None
            if req.pageFrom is not None and req.pageTo is not None:
                page_range = (req.pageFrom, req.pageTo)

            started = time.time()
            task.emit("parsing", f"docling convert pages {page_range or 'all'}")

            def progress(stage: str, page_no: int, total_pages: int) -> None:
                if task.cancel_requested:
                    raise asyncio.CancelledError()
                task.page_no = page_no
                task.total_pages = total_pages

            blocks, page_count = await asyncio.to_thread(
                parsing._convert_with_docling, req.fileName, data, page_range, progress
            )
            if task.cancel_requested:
                raise asyncio.CancelledError()
            task.page_count = page_count
            task.blocks = blocks
            task.status = "completed"
            task.emit("completed", f"{len(blocks)} blocks", duration_ms=int((time.time() - started) * 1000))
        except asyncio.CancelledError:
            task.status = "cancelled"
            task.emit("cancelled", "cooperative cancel between batches")
        except Exception as e:  # parse failures are data, not server errors
            task.status = "failed"
            task.error = f"{type(e).__name__}: {e}"
            task.emit("failed", task.error)

    asyncio.get_event_loop().create_task(run()) if False else None
    # FastAPI runs on an event loop; schedule via the running loop
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Called outside a loop (shouldn't happen from FastAPI) — run eagerly inline
        task.error = "no running event loop"
        task.status = "failed"
        return task.snapshot(include_blocks=False)
    loop.create_task(run())
    return task.snapshot(include_blocks=False)


def parse_status(task_id: str, include_blocks: bool = False) -> Optional[ParseTaskSnapshot]:
    task = _registry.get(task_id)
    if task is None:
        return None
    return task.snapshot(include_blocks=include_blocks)


def cancel_parse(task_id: str) -> Optional[ParseTaskSnapshot]:
    task = _registry.get(task_id)
    if task is None:
        return None
    if task.status == "running":
        task.cancel_requested = True
        task.emit("cancel_requested", "flag set; takes effect between batches")
    return task.snapshot(include_blocks=False)
