"""Seed the demo: ingest the research timeline, verify the latest view, compute changes.

Run: uv run scripts/seed_demo.py   (set MEMORY_ORG in .env to a fresh value for a clean memory)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import pipeline  # noqa: E402

BASE = "https://www.goldmansachs.com/insights/articles/why-ai-companies-may-invest-more-than-500-billion-in-2026"
TIMELINE = [
    BASE,  # 2025-12-18
    "https://www.morganstanley.com/insights/articles/ai-capex-740-billion-banking-opportunity",  # 2026-03-11
    "https://www.goldmansachs.com/insights/articles/s-and-p-500-forecast-to-climb-as-earnings-growth-powers-stocks-higher",  # 2026-05-28
    "https://www.goldmansachs.com/insights/articles/global-investment-is-forecast-to-exceed-1-trillion-in-2026",  # 2026-08-07
    "https://www.goldmansachs.com/insights/articles/can-ai-investment-drive-s-and-p-500-earnings-even-higher",  # 2026-09-23
]

if __name__ == "__main__":
    for url in TIMELINE:
        r = pipeline.ingest(url)
        print(f"ingested {r['date']} {r['author']}: {len(r['claims'])} claims — {r['title']}")
        for c in r["claims"]:
            print(f"   [{c['metric']}] {c['value_usd_bn']} {c['statement'][:100]}")
    for v in pipeline.verify(TIMELINE[0]) + pipeline.verify(TIMELINE[-1]):
        print("verified:", v["result"].get("verdict"), "-", v["claim"]["statement"][:90])
    ch = pipeline.changes(BASE, "hyperscaler AI capex forecasts for 2026 and 2027")
    print("\n" + ch["report"]["headline"])
    for i in ch["report"]["impacts"]:
        print(f" - {i['status']}: {i['thesis'][:80]} → {i['updated_view'][:120]}")
