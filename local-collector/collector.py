"""Fetch and format one identified YouTube transcript as a local text file."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path
from typing import Any, Iterable


VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
MONTHS = {
    name.lower(): number
    for number, names in enumerate(
        ("January Jan", "February Feb", "March Mar", "April Apr", "May", "June Jun",
         "July Jul", "August Aug", "September Sep Sept", "October Oct", "November Nov", "December Dec"),
        start=1,
    )
    for name in names.split()
}


class CollectorError(ValueError):
    """Input or transcript data cannot be safely turned into the output file."""


def _date_in_title(title: str, reference_year: int) -> date | None:
    match = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", title)
    if match:
        try:
            return date(int(match[1]), int(match[2]), int(match[3]))
        except ValueError as exc:
            raise CollectorError("title contains an invalid calendar date") from exc
    match = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b", title)
    if match:
        year_text = match[3]
        year = int(year_text)
        if len(year_text) == 2:
            if reference_year % 100 != year:
                raise CollectorError("two-digit title year does not match the supplied verified date")
            year = reference_year
        try:
            return date(year, int(match[1]), int(match[2]))
        except ValueError as exc:
            raise CollectorError("title contains an invalid calendar date") from exc
    month_names = "|".join(sorted(MONTHS, key=len, reverse=True))
    match = re.search(
        rf"\b({month_names})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?[,]?\s+(\d{{4}})\b",
        title,
        re.IGNORECASE,
    )
    if match:
        try:
            return date(int(match[3]), MONTHS[match[1].lower()], int(match[2]))
        except ValueError as exc:
            raise CollectorError("title contains an invalid calendar date") from exc
    return None


def validate_metadata(video_id: str, title: str, date_text: str) -> date:
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise CollectorError("video ID must be exactly 11 YouTube ID characters")
    if not title.strip() or "\n" in title or "\r" in title:
        raise CollectorError("title must be a non-empty single line")
    try:
        meeting_date = date.fromisoformat(date_text)
    except (TypeError, ValueError) as exc:
        raise CollectorError("date must be a real ISO calendar date (YYYY-MM-DD)") from exc
    title_date = _date_in_title(title, meeting_date.year)
    if title_date is None:
        raise CollectorError("title must contain the meeting date; verify it before collecting")
    if title_date != meeting_date:
        raise CollectorError("date must match the date stated in the video title")
    return meeting_date


def _normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        raise CollectorError("transcript segment text is malformed")
    return re.sub(r"\s+", " ", value).strip()


def _format_time(seconds: float) -> str:
    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, seconds_part = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds_part:02d}"


def format_segments(data: Any) -> tuple[list[str], int]:
    """Accept JSON3 events or youtube-transcript-api raw segment dictionaries."""
    lines: list[str] = []
    seen = 0

    if isinstance(data, dict) and isinstance(data.get("events"), list):
        for event in data["events"]:
            if not isinstance(event, dict):
                raise CollectorError("JSON3 event is malformed")
            if "tStartMs" not in event or "segs" not in event:
                continue
            start_ms = event["tStartMs"]
            segs = event["segs"]
            if isinstance(start_ms, bool) or not isinstance(start_ms, (int, float)) or start_ms < 0:
                raise CollectorError("JSON3 event timestamp is malformed")
            if not isinstance(segs, list):
                raise CollectorError("JSON3 event segments are malformed")
            chunks: list[str] = []
            for seg in segs:
                if not isinstance(seg, dict) or not isinstance(seg.get("utf8"), str):
                    raise CollectorError("JSON3 segment is malformed")
                chunks.append(seg["utf8"])
            text = _normalize_text("".join(chunks))
            seen += 1
            if text:
                lines.append(f"[{_format_time(start_ms / 1000)}] {text}")
        return lines, seen

    if isinstance(data, list):
        for segment in data:
            if not isinstance(segment, dict):
                raise CollectorError("transcript segment is malformed")
            start = segment.get("start")
            if isinstance(start, bool) or not isinstance(start, (int, float)) or start < 0:
                raise CollectorError("transcript segment timestamp is malformed")
            text = _normalize_text(segment.get("text"))
            seen += 1
            if text:
                lines.append(f"[{_format_time(start)}] {text}")
        return lines, seen

    raise CollectorError("transcript JSON must be JSON3 events or a raw segment list")


def fetch_segments(video_id: str) -> list[dict[str, Any]]:
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError as exc:
        raise CollectorError("dependency missing; install requirements.txt in this folder") from exc
    try:
        transcript = YouTubeTranscriptApi().fetch(video_id, languages=["en"])
        return transcript.to_raw_data()
    except Exception as exc:  # Avoid printing library errors that may contain request details.
        raise CollectorError("transcript fetch failed; no transcript content or request details logged") from exc


def _yaml_quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def build_output(video_id: str, title: str, date_text: str, segments: Any) -> tuple[str, int]:
    validate_metadata(video_id, title, date_text)
    lines, count = format_segments(segments)
    if not lines:
        raise CollectorError("transcript has no non-empty timestamped segments")
    content = (
        "---\n"
        f"title: {_yaml_quote(title)}\n"
        f"date: {_yaml_quote(date_text)}\n"
        f"video_id: {_yaml_quote(video_id)}\n"
        'date_source: "title"\n'
        'date_verified: "true"\n'
        "---\n"
        + "\n".join(lines)
    )
    return content, count


def write_once(path: Path, content: str) -> str:
    """Atomically create a file, treating identical existing content as a no-op."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = content.encode("utf-8")
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temp, path)
            return "written"
        except FileExistsError:
            try:
                existing = path.read_bytes()
            except OSError as exc:
                raise CollectorError("output path exists but cannot be read") from exc
            if existing == payload:
                return "duplicate"
            raise CollectorError("refusing to overwrite a different transcript at the output path")
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Save one verified YouTube transcript as a local .txt file.")
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--title", required=True, help="actual video title containing its meeting date")
    parser.add_argument("--date", required=True, help="verified meeting date in YYYY-MM-DD form")
    parser.add_argument("--output-dir", type=Path, default=Path(".local/transcripts"))
    parser.add_argument("--from-json", type=Path, help="use an existing JSON3 or youtube-transcript-api JSON file")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        validate_metadata(args.video_id, args.title, args.date)
        if args.from_json:
            try:
                data = json.loads(args.from_json.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise CollectorError("could not read valid transcript JSON") from exc
        else:
            data = fetch_segments(args.video_id)
        content, count = build_output(args.video_id, args.title, args.date, data)
        target = args.output_dir / f"{args.video_id}.txt"
        status = write_once(target, content)
    except CollectorError as exc:
        print(f"status=error reason={exc}", file=sys.stderr)
        return 2
    except Exception:
        print("status=error reason=unexpected collector failure", file=sys.stderr)
        return 2
    print(f"status={status} segments={count} bytes={len(content.encode('utf-8'))} path={target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
