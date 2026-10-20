"""Fake check_round.py for Crux tests: answers from <round>/fixture-check.json.

Keys are "batch:N" or "lane:NAME" -> {"code": int, "out": [lines]}.
Anything not listed passes.
"""
import json
import os
import sys

args = sys.argv[1:]
round_dir = args[0]
key = None
if "--batch" in args:
    key = "batch:" + args[args.index("--batch") + 1]
if "--lane" in args:
    key = "lane:" + args[args.index("--lane") + 1]
try:
    with open(os.path.join(round_dir, "fixture-check.json")) as f:
        answers = json.load(f)
except OSError:
    answers = {}
answer = answers.get(key, {"code": 0, "out": ["OK: all checks pass for " + str(key)]})
for line in answer["out"]:
    print(line)
sys.exit(answer["code"])
