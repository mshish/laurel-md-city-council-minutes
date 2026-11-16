import json
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

from monitor import MonitorError, is_completed_stream, is_target_title, run_monitor, scan_channel, verified_meeting_date


def timestamp(year, month, day):
    return datetime(year, month, day, tzinfo=timezone.utc).timestamp()


def stream(video_id, title, **fields):
    return {"id": video_id, "title": title, **fields}


class FakeYDL:
    def __init__(self, options, owner):
        self.options = options
        self.owner = owner

    def __enter__(self):
        self.owner.options.append(self.options)
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, url, download=False):
        self.owner.download_args.append(download)
        if url.endswith("/streams"):
            return {"entries": [
                {"id": "RBey6C45RNs", "title": "Mayor and City Council Meeting 10/26/26"},
                {"id": "AAAAAAAAAAA", "title": "Mayor and City Council Work Session 11/02/26"},
                {"id": "BBBBBBBBBBB", "title": "Mayor Update 11/03/26"},
            ]}
        return self.owner.details[url.rsplit("=", 1)[-1]]


class FakeFactory:
    def __init__(self):
        self.options = []
        self.download_args = []
        self.details = {
            "RBey6C45RNs": stream("RBey6C45RNs", "Mayor and City Council Meeting 10/26/26", live_status="was_live", was_live=True, release_timestamp=timestamp(2026, 10, 26)),
            "AAAAAAAAAAA": stream("AAAAAAAAAAA", "Mayor and City Council Work Session 11/02/26", live_status="is_upcoming", release_timestamp=timestamp(2026, 11, 2)),
        }

    def __call__(self, options):
        return FakeYDL(options, self)


class MonitorTests(unittest.TestCase):
    def test_title_filter_and_completed_stream_rules(self):
        self.assertTrue(is_target_title("In-Person Mayor and City Council Work-Session 10/26/26"))
        self.assertFalse(is_target_title("Mayor Update 10/26/26"))
        self.assertFalse(is_completed_stream({"live_status": "is_live", "was_live": True}))
        self.assertFalse(is_completed_stream({"live_status": "is_upcoming", "was_live": True}))
        self.assertTrue(is_completed_stream({"live_status": "was_live"}))
        self.assertTrue(is_completed_stream({"live_status": "not_live", "was_live": True}))

    def test_two_digit_date_requires_stream_year_match(self):
        good = stream("RBey6C45RNs", "In-Person Mayor and City Council Meeting 10/26/26", release_timestamp=timestamp(2026, 10, 26))
        bad = {**good, "release_timestamp": timestamp(2025, 10, 26)}
        self.assertEqual(verified_meeting_date(good), "2026-10-26")
        self.assertIsNone(verified_meeting_date(bad))
        self.assertIsNone(verified_meeting_date({"id": "RBey6C45RNs", "title": "Mayor and City Council Meeting 10/26/26"}))

    def test_two_digit_year_uses_eastern_year_at_utc_new_year_boundary(self):
        # Jan 1 01:00 UTC is still Dec 31 in Laurel.
        crossing = stream(
            "RBey6C45RNs",
            "Mayor and City Council Meeting 12/31/25",
            release_timestamp=timestamp(2026, 1, 1) + 3600,
        )
        self.assertEqual(verified_meeting_date(crossing), "2025-12-31")

    def test_scan_uses_flat_metadata_then_video_metadata_with_no_download(self):
        factory = FakeFactory()
        candidates = scan_channel(factory)
        self.assertEqual(candidates, [{
            "video_id": "RBey6C45RNs",
            "title": "Mayor and City Council Meeting 10/26/26",
            "date": "2026-10-26",
        }])
        self.assertEqual(factory.download_args, [False, False, False])
        self.assertTrue(all(options["skip_download"] for options in factory.options))
        self.assertTrue(factory.options[0]["extract_flat"])
        self.assertEqual(factory.options[0]["playlistend"], 50)
        self.assertEqual(factory.options[0]["socket_timeout"], 20)
        self.assertEqual(factory.options[0]["retries"], 2)
        self.assertTrue(factory.options[0]["ignore_no_formats_error"])
        self.assertNotIn("extract_flat", factory.options[1])

    def test_scan_reports_title_matches_and_per_video_metadata_failures(self):
        class FailingFactory(FakeFactory):
            def __call__(self, options):
                parent = self
                class Context(FakeYDL):
                    def extract_info(self, url, download=False):
                        if "watch?v=AAAAAAAAAAA" in url:
                            raise RuntimeError("details omitted")
                        return super().extract_info(url, download)
                return Context(options, parent)

        stats = {}
        candidates = scan_channel(FailingFactory(), scan_stats=stats)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(stats["channel_entries"], 3)
        self.assertEqual(stats["title_matches"], 2)
        self.assertEqual(stats["metadata_attempts"], 2)
        self.assertEqual(stats["metadata_failures"], 1)
        self.assertEqual(stats["incomplete_streams"], 0)

    def test_monitor_manifest_is_local_idempotent_and_does_not_mark_failures_exported(self):
        candidates = [
            {"video_id": "RBey6C45RNs", "title": "Mayor and City Council Meeting 10/26/26", "date": "2026-10-26"},
            {"video_id": "AAAAAAAAAAA", "title": "Mayor and City Council Meeting 11/02/26", "date": "2026-11-02"},
        ]
        calls = []

        def fetch(video_id):
            calls.append(video_id)
            if video_id == "AAAAAAAAAAA":
                raise RuntimeError("failure with request details")
            return [{"text": "Council meeting.", "start": 1.2, "duration": 1.0}]

        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            output = base / "transcripts"
            manifest_path = base / "manifest.json"
            result = run_monitor(output, manifest_path, max_transcripts=10, scanner=lambda: candidates, fetcher=fetch)
            self.assertEqual(result, (1, 1, 2))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual([row["video_id"] for row in manifest["transcripts"]], ["RBey6C45RNs"])
            self.assertEqual(manifest["failures"], [{"video_id": "AAAAAAAAAAA", "reason": "transcript_not_saved"}])
            self.assertNotIn("Council meeting.", manifest_path.read_text(encoding="utf-8"))
            self.assertTrue((output / "RBey6C45RNs.txt").is_file())
            self.assertFalse((output / "AAAAAAAAAAA.txt").exists())
            self.assertEqual(run_monitor(output, manifest_path, scanner=lambda: candidates, fetcher=fetch), (0, 2, 2))
            self.assertEqual(calls, ["RBey6C45RNs", "AAAAAAAAAAA", "AAAAAAAAAAA"])

    def test_discover_only_never_fetches_transcripts(self):
        candidate = {"video_id": "RBey6C45RNs", "title": "Mayor and City Council Meeting 10/26/26", "date": "2026-10-26"}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            result = run_monitor(
                base / "out", base / "manifest.json", discover_only=True,
                scanner=lambda: [candidate],
                fetcher=lambda _video_id: self.fail("discover-only called transcript fetcher"),
            )
            self.assertEqual(result, (0, 0, 1))
            manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["candidates"], [candidate])

    def test_lookback_filters_verified_dates_and_rejects_out_of_range(self):
        candidates = [
            {"video_id": "RBey6C45RNs", "title": "Mayor and City Council Meeting 10/26/26", "date": "2026-10-26"},
            {"video_id": "AAAAAAAAAAA", "title": "Mayor and City Council Meeting 9/01/26", "date": "2026-09-01"},
            {"video_id": "BBBBBBBBBBB", "title": "Mayor and City Council Meeting 11/17/26", "date": "2026-11-17"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            result = run_monitor(
                base / "out", base / "manifest.json", discover_only=True,
                scanner=lambda: candidates, today=date(2026, 11, 16),
                lookback_days=45,
            )
            self.assertEqual(result, (0, 0, 1))
            manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual([item["video_id"] for item in manifest["candidates"]], ["RBey6C45RNs"])
            self.assertEqual(manifest["scan_counts"]["lookback_rejected"], 2)
            with self.assertRaisesRegex(MonitorError, "between 1 and 120"):
                run_monitor(base / "out", base / "manifest.json", scanner=lambda: [], lookback_days=121)


if __name__ == "__main__":
    unittest.main()
