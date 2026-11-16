import json
import tempfile
import unittest
from pathlib import Path

from collector import CollectorError, build_output, format_segments, validate_metadata, write_once


VIDEO_ID = "RBey6C45RNs"
TITLE = "Mayor and City Council Meeting - November 14, 2026"
DATE = "2026-11-14"


class CollectorTests(unittest.TestCase):
    def test_formats_api_raw_segments_and_frontmatter(self):
        data = [
            {"text": " Council ", "start": 1.9, "duration": 2.0},
            {"text": "meeting.\nNext.", "start": 3661.0, "duration": 1.0},
        ]
        content, count = build_output(VIDEO_ID, TITLE, DATE, data)
        self.assertEqual(count, 2)
        self.assertTrue(content.startswith(
            '---\ntitle: "Mayor and City Council Meeting - November 14, 2026"\n'
            'date: "2026-11-14"\nvideo_id: "RBey6C45RNs"\n'
            'date_source: "title"\ndate_verified: "true"\n---\n'
        ))
        self.assertTrue(content.endswith("[00:00:01] Council\n[01:01:01] meeting. Next."))

    def test_formats_json3_fixture(self):
        lines, count = format_segments({"events": [
            {"tStartMs": 1230, "segs": [{"utf8": " A "}, {"utf8": "line. "}]},
            {"tStartMs": 3661000, "segs": [{"utf8": "Later."}]},
            {"segs": [{"utf8": "skip missing start"}]},
        ]})
        self.assertEqual(count, 2)
        self.assertEqual(lines, ["[00:00:01] A line.", "[01:01:01] Later."])

    def test_rejects_bad_id_dates_and_title_date_mismatch(self):
        with self.assertRaisesRegex(CollectorError, "11 YouTube"):
            validate_metadata("short", TITLE, DATE)
        with self.assertRaisesRegex(CollectorError, "real ISO"):
            validate_metadata(VIDEO_ID, TITLE, "2026-02-30")
        with self.assertRaisesRegex(CollectorError, "match"):
            validate_metadata(VIDEO_ID, TITLE, "2026-11-13")
        with self.assertRaisesRegex(CollectorError, "invalid calendar"):
            validate_metadata(VIDEO_ID, "Meeting - February 30, 2026", "2026-02-28")

    def test_two_digit_title_year_is_checked_against_supplied_verified_date(self):
        validate_metadata(VIDEO_ID, "In-Person 22nd Mayor and City Council Meeting 10/26/26", "2026-10-26")
        with self.assertRaisesRegex(CollectorError, "two-digit title year"):
            validate_metadata(VIDEO_ID, "In-Person 22nd Mayor and City Council Meeting 10/26/26", "2027-10-26")

    def test_rejects_malformed_segments(self):
        fixtures = [
            [{"text": "missing time"}],
            [{"text": 3, "start": 0}],
            {"events": [{"tStartMs": "1", "segs": [{"utf8": "bad"}]}]},
            {"events": [{"tStartMs": 1, "segs": [None]}]},
        ]
        for fixture in fixtures:
            with self.subTest(fixture=fixture), self.assertRaises(CollectorError):
                format_segments(fixture)

    def test_identical_output_is_noop_and_conflict_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / f"{VIDEO_ID}.txt"
            self.assertEqual(write_once(path, "first"), "written")
            self.assertEqual(write_once(path, "first"), "duplicate")
            with self.assertRaisesRegex(CollectorError, "overwrite"):
                write_once(path, "different")
            self.assertEqual(path.read_text(encoding="utf-8"), "first")


if __name__ == "__main__":
    unittest.main()
