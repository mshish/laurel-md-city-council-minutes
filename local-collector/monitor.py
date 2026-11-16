"""Metadata-only channel discovery and local transcript collection."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from collector import CollectorError, build_output, fetch_segments, validate_metadata, write_once


CHANNEL_URL = "https://www.youtube.com/@LaurelTVOfficial/streams"
MAX_CHANNEL_ITEMS = 50
MAX_TRANSCRIPTS = 50
EASTERN = ZoneInfo("America/New_York")


class MonitorError(RuntimeError):
    pass


class SilentLogger:
    """Keep extractor URLs and diagnostic details out of scheduled logs."""

    def debug(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass


def _stream_year(info: dict[str, Any]) -> int | None:
    for key in ("release_timestamp", "start_time"):
        value = info.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            try:
                return datetime.fromtimestamp(value, timezone.utc).astimezone(EASTERN).year
            except (OverflowError, OSError, ValueError):
                continue
        if isinstance(value, str) and value:
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    continue
                return parsed.astimezone(EASTERN).year
            except ValueError:
                continue
    return None


def verified_meeting_date(info: dict[str, Any]) -> str | None:
    """Require an explicit title date; use stream metadata to resolve two-digit years."""
    title = info.get("title")
    video_id = info.get("id")
    if not isinstance(title, str) or not isinstance(video_id, str):
        return None
    stream_year = _stream_year(info)
    iso_match = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", title)
    numeric_match = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b", title)
    try:
        if iso_match:
            match = iso_match
            result = date(int(match[1]), int(match[2]), int(match[3]))
            if stream_year is not None and result.year != stream_year:
                return None
        elif numeric_match:
            match = numeric_match
            year_text = match[3]
            if len(year_text) == 2:
                if stream_year is None or stream_year % 100 != int(year_text):
                    return None
                year = stream_year
            else:
                year = int(year_text)
                if stream_year is not None and year != stream_year:
                    return None
            result = date(year, int(match[1]), int(match[2]))
        else:
            return None
        validate_metadata(video_id, title, result.isoformat())
    except (CollectorError, ValueError):
        return None
    return result.isoformat()


def is_target_title(title: Any) -> bool:
    if not isinstance(title, str):
        return False
    normalized = title.casefold()
    if "mayor" not in normalized or "city council" not in normalized:
        return False
    return bool(re.search(r"\bmeeting\b|\bwork[ -]?session\b", normalized))


def is_completed_stream(info: dict[str, Any]) -> bool:
    status = info.get("live_status")
    if status in {"is_live", "is_upcoming"}:
        return False
    return status in {"was_live", "post_live"} or (
        info.get("was_live") is True and status in {None, "not_live"}
    )


def _extract_options(*, flat: bool = False) -> dict[str, Any]:
    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "ignoreerrors": True,
        "ignore_no_formats_error": True,
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 2,
        "fragment_retries": 0,
        "logger": SilentLogger(),
    }
    if flat:
        options["extract_flat"] = True
        options["playlistend"] = MAX_CHANNEL_ITEMS
    return options


def scan_channel(youtube_dl_factory=None, scan_stats: dict[str, int] | None = None) -> list[dict[str, str]]:
    """Inspect the newest channel entries flat, then fetch metadata only for title matches."""
    if youtube_dl_factory is None:
        try:
            from yt_dlp import YoutubeDL
        except ImportError as exc:
            raise MonitorError("yt-dlp missing; install requirements.txt in this folder") from exc
        youtube_dl_factory = YoutubeDL
    stats = scan_stats if scan_stats is not None else {}
    stats.update({"channel_entries": 0, "title_matches": 0, "metadata_attempts": 0,
                  "metadata_failures": 0, "incomplete_streams": 0,
                  "unverified_dates": 0, "eligible_candidates": 0})
    try:
        with youtube_dl_factory(_extract_options(flat=True)) as ydl:
            channel = ydl.extract_info(CHANNEL_URL, download=False)
        if not isinstance(channel, dict) or not isinstance(channel.get("entries"), list):
            raise MonitorError("channel metadata unavailable")
        listing = channel["entries"][:MAX_CHANNEL_ITEMS]
        stats["channel_entries"] = len(listing)
        candidate_entries = [entry for entry in listing if isinstance(entry, dict) and is_target_title(entry.get("title"))]
        stats["title_matches"] = len(candidate_entries)
        found: list[dict[str, str]] = []
        with youtube_dl_factory(_extract_options()) as ydl:
            for entry in candidate_entries:
                video_id = entry.get("id")
                if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                    stats["metadata_failures"] += 1
                    continue
                stats["metadata_attempts"] += 1
                try:
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
                except Exception:
                    stats["metadata_failures"] += 1
                    continue
                if not isinstance(info, dict) or not is_target_title(info.get("title")):
                    stats["metadata_failures"] += 1
                    continue
                if not is_completed_stream(info):
                    stats["incomplete_streams"] += 1
                    continue
                meeting_date = verified_meeting_date(info)
                if meeting_date is None:
                    stats["unverified_dates"] += 1
                    continue
                found.append({"video_id": video_id, "title": info["title"], "date": meeting_date})
        stats["eligible_candidates"] = len(found)
        return found
    except MonitorError:
        raise
    except Exception as exc:
        raise MonitorError("channel metadata scan failed") from exc


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"schema_version": 1, "candidates": [], "transcripts": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MonitorError("manifest could not be read as valid JSON") from exc
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise MonitorError("manifest has an unsupported schema")
    if not isinstance(value.get("transcripts"), list):
        raise MonitorError("manifest transcript list is malformed")
    if not isinstance(value.get("candidates", []), list):
        raise MonitorError("manifest candidate list is malformed")
    return value


def save_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
        temp.replace(path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _existing_transcripts(output_dir: Path, manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    existing: dict[str, dict[str, Any]] = {}
    for record in manifest["transcripts"]:
        if not isinstance(record, dict) or not isinstance(record.get("video_id"), str):
            continue
        local_path = output_dir / f"{record['video_id']}.txt"
        if local_path.is_file():
            existing[record["video_id"]] = record
    return existing


def run_monitor(output_dir: Path, manifest_path: Path, max_transcripts: int = 10,
                discover_only: bool = False, video_ids: set[str] | None = None,
                scanner=scan_channel, fetcher=fetch_segments,
                lookback_days: int = 45, today: date | None = None) -> tuple[int, int, int]:
    if not 1 <= max_transcripts <= MAX_TRANSCRIPTS:
        raise MonitorError(f"--max-transcripts must be between 1 and {MAX_TRANSCRIPTS}")
    if not 1 <= lookback_days <= 120:
        raise MonitorError("--lookback-days must be between 1 and 120")
    manifest = load_manifest(manifest_path)
    scan_counts: dict[str, int] = {}
    if scanner is scan_channel:
        candidates = scanner(scan_stats=scan_counts)
    else:
        candidates = scanner()
        scan_counts = {"eligible_candidates": len(candidates)}
    if today is None:
        today = datetime.now(EASTERN).date()
    cutoff = today - timedelta(days=lookback_days)
    before_lookback = len(candidates)
    candidates = [item for item in candidates if cutoff <= date.fromisoformat(item["date"]) <= today]
    scan_counts["lookback_rejected"] = before_lookback - len(candidates)
    if video_ids:
        candidates = [item for item in candidates if item["video_id"] in video_ids]
    manifest["scanned_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest["scan_counts"] = scan_counts
    manifest["candidates"] = candidates
    manifest["failures"] = []
    existing = _existing_transcripts(output_dir, manifest)

    if discover_only:
        save_manifest(manifest_path, manifest)
        return 0, 0, len(candidates)

    newly_written = skipped = processed = 0
    transcripts = dict(existing)
    for item in candidates:
        video_id, title, meeting_date = item["video_id"], item["title"], item["date"]
        target = output_dir / f"{video_id}.txt"
        if video_id in existing:
            skipped += 1
            continue
        if processed >= max_transcripts:
            break
        processed += 1
        try:
            content, segment_count = build_output(video_id, title, meeting_date, fetcher(video_id))
            status = write_once(target, content)
            transcripts[video_id] = {
                "video_id": video_id,
                "title": title,
                "date": meeting_date,
                "file_path": str(target.resolve()),
                "segments": segment_count,
            }
            if status == "written":
                newly_written += 1
            else:
                skipped += 1
        except Exception:
            # Failures are intentionally absent from the exported manifest and retried next scan.
            manifest["failures"].append({"video_id": video_id, "reason": "transcript_not_saved"})
            skipped += 1
    manifest["transcripts"] = list(transcripts.values())
    save_manifest(manifest_path, manifest)
    return newly_written, skipped, len(candidates)


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Discover completed Laurel council streams and save transcript text locally.")
    parser.add_argument("--output-dir", type=Path, default=Path(".local/transcripts"))
    parser.add_argument("--manifest", type=Path, default=Path(".local/transcripts/manifest.json"))
    parser.add_argument("--max-transcripts", type=int, default=10)
    parser.add_argument("--lookback-days", type=int, default=45)
    parser.add_argument("--discover-only", action="store_true", help="write candidates to manifest without fetching transcripts")
    parser.add_argument("--video-id", action="append", dest="video_ids", help="only collect this identified video (repeatable)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        written, skipped, candidates = run_monitor(
            args.output_dir,
            args.manifest,
            max_transcripts=args.max_transcripts,
            lookback_days=args.lookback_days,
            discover_only=args.discover_only,
            video_ids=set(args.video_ids) if args.video_ids else None,
        )
    except MonitorError as exc:
        print(f"status=error reason={exc}", file=sys.stderr)
        return 2
    except Exception:
        print("status=error reason=unexpected monitor failure", file=sys.stderr)
        return 2
    counts = load_manifest(args.manifest).get("scan_counts", {})
    print(
        f"status=complete candidates={candidates} written={written} skipped={skipped} "
        f"title_matches={counts.get('title_matches', 0)} metadata_failures={counts.get('metadata_failures', 0)} "
        f"lookback_rejected={counts.get('lookback_rejected', 0)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
