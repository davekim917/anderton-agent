#!/usr/bin/env python3
"""Where the controller learns whether a run's finish kept another run's hold."""

import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("controller", HERE / "smoke-campaign-controller.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)

RUN = "acme-pr-pr7-aaaaaaaaaaaa-20260918T100000Z"
OTHER = "acme-pr-pr7-bbbbbbbbbbbb-20260918T120000Z"
KEPT = {"runId": "acme-pr-pr5-cccccccccccc-20260917T090000Z", "verdict": "HUMAN_DECISION"}


def done(verb, detail):
    return {ctl.obligation_key(RUN, "gate", verb): {"state": "done", "detail": detail}}


def receipt(run_id, kept):
    return {"runId": run_id, "verdict": "GO", "handoff": {"written": True, "holdKept": kept}}


class HoldKept(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = os.path.join(self.tmp.name, "ledger.jsonl")

    def tearDown(self):
        self.tmp.cleanup()

    def ask(self, pv, obs=None, ordinary=False):
        return ctl.Controller._hold_kept(SimpleNamespace(ledger_path=self.ledger), RUN, pv, obs or {}, ordinary)

    def test_journaled_handoff_answers_first(self):
        self.assertEqual(self.ask(receipt(OTHER, None), done("finish", {"result": {"handoff": {"holdKept": KEPT}}})),
                         KEPT)

    def test_journaled_explicit_null_answers(self):
        self.assertIsNone(self.ask(receipt(OTHER, None), done("finish", {"result": {"handoff": {"holdKept": None}}})))

    def test_result_without_handoff_does_not_answer(self):
        # The gate's idempotent finish returns the run verdict with no handoff.
        obs = done("finish-resume", {"result": {"ok": True, "idempotent": True, "verdict": "GO"}})
        self.assertEqual(self.ask(receipt(RUN, KEPT), obs), KEPT)

    def test_ledger_line_answers_when_receipt_is_another_runs(self):
        with open(self.ledger, "w") as fh:
            fh.write(json.dumps({"runId": RUN, "holdKept": KEPT}) + "\n")
        self.assertEqual(self.ask(receipt(OTHER, None)), KEPT)

    def test_ordinary_pr_settles_without_a_ledger(self):
        self.assertIsNone(self.ask(receipt(OTHER, None), ordinary=True))

    def test_unknown_with_unreadable_ledger_fails_the_step(self):
        obs = done("finish", {"outcome": "reconciled", "verdict": "GO"})
        with self.assertRaises(ctl.ControllerError):
            self.ask(receipt(OTHER, None), obs)


if __name__ == "__main__":
    unittest.main()
